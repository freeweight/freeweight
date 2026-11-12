// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {WeightVault} from "../src/WeightVault.sol";
import {IWeightVault} from "../src/IWeightVault.sol";
import {MockToken, BlocklistToken, SpyToken} from "./mocks/Mocks.sol";

/// @dev Regression tests. Cases that were fixed assert the
///      fixed behaviour (see also WeightVault.t.sol). The tests here pin behaviour that
///      is documented rather than changed: gateway-side rules and token-side trust assumptions.
contract RegressionTest is Test {
    MockToken token;
    WeightVault vault;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    // a UTC day boundary
    uint256 constant DAY0 = 1_800_000_000 - (1_800_000_000 % 1 days);

    function setUp() public {
        vm.warp(DAY0);
        token = new MockToken();
        vault = new WeightVault(address(token), owner);
        token.mint(alice, 1_000_000 ether);
        token.mint(bob, 1_000_000 ether);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------ regression: re-request and cooldown raise, end to end

    /// regression: the re-request scenarios, now asserting the fixed behaviour.
    function test_rerequestAfterCooldownRaise_cannotRelockMaturedFunds() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(99 ether, type(uint256).max);
        (, uint256 unlock) = vault.pendingUnstake(alice);
        vm.stopPrank();
        skip(7 days);
        vm.prank(owner);
        vault.setCooldown(30 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.WithdrawFirst.selector, unlock));
        vault.requestUnstake(1, type(uint256).max);
        vm.prank(alice);
        vault.withdraw(); // the matured 99 ether is still withdrawable
        assertEq(token.balanceOf(alice), 1_000_000 ether - 1 ether);
    }

    function test_ownerRaiseBeforeRequest_cannotLengthenExitBeyondMax() public {
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(owner);
        vault.setCooldown(30 days); // lands first, same block
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IWeightVault.CooldownAboveMax.selector, 30 days, 7 days)
        );
        vault.requestUnstake(100 ether, 7 days); // alice signed expecting 7 days
    }

    // ------------------------------------------------------------ regression: UTC-day boundary (gateway rule)

    /// Rule as first specified: age checked at claim time.
    function _eligibleAtClaim(address u, uint256 minAge) internal view returns (bool) {
        (uint256 staked, uint256 since,,) = vault.positionOf(u);
        return since != 0 && block.timestamp - since >= minAge && staked > 0;
    }

    /// Documented rule: credit day D only if the stake was already aged at the START of D.
    function _eligibleDayStart(address u, uint256 minAge) internal view returns (bool) {
        (uint256 staked, uint256 since,,) = vault.positionOf(u);
        uint256 dayStart = block.timestamp - (block.timestamp % 1 days);
        return since != 0 && since + minAge <= dayStart && staked > 0;
    }

    /// Documents why the README rule compares with the day start: with the claim-time rule about
    /// 24 h of stake earns two daily credits, with the day-start rule one.
    function test_stakeAcrossUtcBoundary_dayStartRuleGivesOneCreditFor24h() public {
        vm.prank(owner);
        vault.setCooldown(0);
        uint256 minAge = 24 hours;

        vm.warp(DAY0 + 23 hours + 58 minutes);
        vm.prank(alice);
        vault.stake(1000 ether);
        uint256 t0 = block.timestamp;

        uint256 claimTime;
        uint256 dayStart;
        vm.warp(DAY0 + 1 days + 23 hours + 59 minutes);
        if (_eligibleAtClaim(alice, minAge)) claimTime++;
        if (_eligibleDayStart(alice, minAge)) dayStart++;
        vm.warp(DAY0 + 2 days + 30);
        if (_eligibleAtClaim(alice, minAge)) claimTime++;
        if (_eligibleDayStart(alice, minAge)) dayStart++;

        vm.startPrank(alice);
        vault.requestUnstake(1000 ether, type(uint256).max);
        vault.withdraw();
        vm.stopPrank();
        uint256 held = block.timestamp - t0;

        console2.log("held seconds", held);
        assertEq(held, 24 hours + 2 minutes + 30);
        assertEq(claimTime, 2, "claim-time rule: two credits for ~24 h");
        assertEq(dayStart, 1, "day-start rule: one credit");
    }

    // ------------------------------------------------------------ regression: token blocklist

    /// A token blocklist (not expected for $WEIGHT) traps a blocked user's withdrawal until it is
    /// lifted; cancelUnstake still works. Deployment checklist requires a fork round trip.
    function test_tokenBlocklist_trapsWithdrawButCancelWorks() public {
        BlocklistToken bt = new BlocklistToken();
        WeightVault v = new WeightVault(address(bt), owner);
        bt.mint(alice, 10 ether);
        vm.startPrank(alice);
        bt.approve(address(v), 10 ether);
        v.stake(10 ether);
        v.requestUnstake(10 ether, type(uint256).max);
        vm.stopPrank();
        skip(7 days);
        bt.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert(bytes("blocked"));
        v.withdraw();
        (uint256 p,) = v.pendingUnstake(alice);
        assertEq(p, 10 ether);
        vm.prank(alice);
        v.cancelUnstake();
        assertEq(v.stakedOf(alice), 10 ether);
        bt.setBlocked(alice, false);
        vm.startPrank(alice);
        v.requestUnstake(10 ether, type(uint256).max);
        skip(7 days);
        v.withdraw();
        vm.stopPrank();
        assertEq(bt.balanceOf(alice), 10 ether);
    }

    // ------------------------------------------------------------ read-only reentrancy

    /// Mid-withdraw every per-user view and total is already final; mid-stake the views are still
    /// the old ones. Both are internally consistent for a reader of the views.
    function test_viewsConsistentDuringTransferHooks() public {
        SpyToken st = new SpyToken();
        WeightVault v = new WeightVault(address(st), owner);
        st.mint(alice, 100 ether);
        vm.startPrank(alice);
        st.approve(address(v), 100 ether);
        st.arm(v, alice);
        v.stake(100 ether);
        assertEq(st.seenStaked(), 0);
        assertEq(st.seenTotalStaked(), 0);
        assertEq(st.seenSince(), 0);
        assertEq(st.seenBalance(), 100 ether);

        v.requestUnstake(100 ether, type(uint256).max);
        skip(7 days);
        st.arm(v, alice);
        v.withdraw();
        vm.stopPrank();
        assertEq(st.seenPending(), 0);
        assertEq(st.seenTotalPending(), 0);
        assertEq(st.seenStaked(), 0);
    }

    // ------------------------------------------------------------ misc soundness

    /// Splitting across addresses gains nothing if credits are linear in stake (gateway assumption).
    function test_splitNoGainUnderLinearCredits() public {
        vm.prank(alice);
        vault.stake(600 ether);
        vm.prank(bob);
        vault.stake(400 ether);
        skip(1 days);
        assertEq(vault.stakedOf(alice) + vault.stakedOf(bob), vault.totalStaked());
        assertEq(vault.stakedSince(alice), DAY0);
        assertEq(vault.stakedSince(bob), DAY0);
    }

    /// uint64 casts: block.timestamp + MAX_COOLDOWN fits until about year 5.8e11.
    function test_uint64HeadroomAtFarFuture() public {
        vm.warp(type(uint64).max - 30 days);
        vm.prank(owner);
        vault.setCooldown(30 days);
        vm.startPrank(alice);
        vault.stake(1 ether);
        vault.requestUnstake(1 ether, type(uint256).max);
        vm.stopPrank();
        (, uint256 unlock) = vault.pendingUnstake(alice);
        assertEq(unlock, type(uint64).max);
    }
}
