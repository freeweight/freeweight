// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {WeightVault} from "../src/WeightVault.sol";
import {IWeightVault} from "../src/IWeightVault.sol";
import {
    MockToken,
    FeeToken,
    ReentrantToken,
    NoopToken,
    CeiSpyToken,
    MutantVault
} from "./mocks/Mocks.sol";

contract WeightVaultTest is Test {
    event Staked(address indexed user, uint256 amount, uint256 newStaked);
    event UnstakeRequested(address indexed user, uint256 amount, uint256 unlockTime);
    event UnstakeCancelled(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    MockToken token;
    WeightVault vault;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 constant CD = 7 days;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockToken();
        vault = new WeightVault(address(token), owner);
        for (uint256 i; i < 2; i++) {
            address u = i == 0 ? alice : bob;
            token.mint(u, 1_000_000 ether);
            vm.prank(u);
            token.approve(address(vault), type(uint256).max);
        }
    }

    // ------------------------------------------------------------ constructor / metadata

    function test_constructor() public view {
        assertEq(vault.token(), address(token));
        assertEq(vault.owner(), owner);
        assertEq(vault.cooldown(), 7 days);
        assertEq(vault.MAX_COOLDOWN(), 30 days);
        assertEq(vault.totalStaked(), 0);
        assertEq(vault.totalPending(), 0);
    }

    function test_constructor_revertsOnZeroToken() public {
        vm.expectRevert(IWeightVault.ZeroAddress.selector);
        new WeightVault(address(0), owner);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new WeightVault(address(token), address(0));
    }

    // ------------------------------------------------------------ stake

    function test_stake() public {
        vm.expectEmit(true, false, false, true);
        emit Staked(alice, 100 ether, 100 ether);
        vm.prank(alice);
        vault.stake(100 ether);

        assertEq(vault.stakedOf(alice), 100 ether);
        assertEq(vault.totalStaked(), 100 ether);
        assertEq(vault.stakedSince(alice), block.timestamp);
        assertEq(token.balanceOf(address(vault)), 100 ether);
        assertEq(token.balanceOf(alice), 1_000_000 ether - 100 ether);
    }

    function test_stake_twiceAccumulatesAndRestartsAge() public {
        vm.prank(alice);
        vault.stake(100 ether);
        uint256 t0 = block.timestamp;
        skip(2 days);
        vm.prank(alice);
        vault.stake(50 ether);
        assertEq(vault.stakedOf(alice), 150 ether);
        assertEq(vault.stakedSince(alice), t0 + 2 days);
    }

    function test_stake_revertsOnZero() public {
        vm.expectRevert(IWeightVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.stake(0);
    }

    function test_stake_revertsWithoutAllowance() public {
        address carol = makeAddr("carol");
        token.mint(carol, 10 ether);
        vm.expectRevert();
        vm.prank(carol);
        vault.stake(10 ether);
    }

    function test_stake_revertsWithoutBalance() public {
        address carol = makeAddr("carol");
        vm.prank(carol);
        token.approve(address(vault), 10 ether);
        vm.expectRevert();
        vm.prank(carol);
        vault.stake(10 ether);
    }

    function test_stake_usersAreIndependent() public {
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(bob);
        vault.stake(300 ether);
        assertEq(vault.stakedOf(alice), 100 ether);
        assertEq(vault.stakedOf(bob), 300 ether);
        assertEq(vault.totalStaked(), 400 ether);
    }

    // ------------------------------------------------------------ requestUnstake

    function test_requestUnstake_partial() public {
        vm.prank(alice);
        vault.stake(100 ether);
        uint256 t0 = block.timestamp;
        skip(1 days);

        vm.expectEmit(true, false, false, true);
        emit UnstakeRequested(alice, 40 ether, block.timestamp + CD);
        vm.prank(alice);
        vault.requestUnstake(40 ether, type(uint256).max);

        assertEq(vault.stakedOf(alice), 60 ether);
        assertEq(vault.totalStaked(), 60 ether);
        assertEq(vault.totalPending(), 40 ether);
        (uint256 amt, uint256 unlock) = vault.pendingUnstake(alice);
        assertEq(amt, 40 ether);
        assertEq(unlock, block.timestamp + CD);
        // partial unstake does not reset the age of what stays
        assertEq(vault.stakedSince(alice), t0);
        // funds have not left the vault
        assertEq(token.balanceOf(address(vault)), 100 ether);
    }

    function test_requestUnstake_all_clearsStakedSince() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(100 ether, type(uint256).max);
        vm.stopPrank();
        assertEq(vault.stakedOf(alice), 0);
        assertEq(vault.stakedSince(alice), 0);
    }

    /// Regression: an owner raise ordered before the request cannot lengthen an exit
    /// beyond what the caller accepted.
    function test_requestUnstake_maxCooldownProtectsAgainstRaise() public {
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(owner);
        vault.setCooldown(30 days);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.CooldownAboveMax.selector, 30 days, CD));
        vault.requestUnstake(100 ether, CD);
        // accepting the longer cooldown works, and exactly-equal is accepted
        vault.requestUnstake(40 ether, 30 days);
        vm.stopPrank();
        (, uint256 unlock) = vault.pendingUnstake(alice);
        assertEq(unlock, block.timestamp + 30 days);
    }

    function test_requestUnstake_maxCooldownZeroNeedsZeroCooldown() public {
        vm.prank(alice);
        vault.stake(10 ether);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.CooldownAboveMax.selector, CD, 0));
        vm.prank(alice);
        vault.requestUnstake(10 ether, 0);
        vm.prank(owner);
        vault.setCooldown(0);
        vm.prank(alice);
        vault.requestUnstake(10 ether, 0);
    }

    function test_requestUnstake_revertsOnZero() public {
        vm.prank(alice);
        vault.stake(1 ether);
        vm.expectRevert(IWeightVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.requestUnstake(0, type(uint256).max);
    }

    function test_requestUnstake_revertsAboveStaked() public {
        vm.startPrank(alice);
        vault.stake(10 ether);
        vm.expectRevert(
            abi.encodeWithSelector(IWeightVault.InsufficientStaked.selector, 11 ether, 10 ether)
        );
        vault.requestUnstake(11 ether, type(uint256).max);
        vm.stopPrank();
    }

    function test_requestUnstake_revertsWithNothingStaked() public {
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.InsufficientStaked.selector, 1, 0));
        vm.prank(alice);
        vault.requestUnstake(1, type(uint256).max);
    }

    function test_requestUnstake_cannotUnstakeWhatIsAlreadyPending() public {
        vm.startPrank(alice);
        vault.stake(10 ether);
        vault.requestUnstake(10 ether, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.InsufficientStaked.selector, 1, 0));
        vault.requestUnstake(1, type(uint256).max);
        vm.stopPrank();
    }

    function test_requestUnstake_secondRequestWhileLockedAddsAndExtendsUnlock() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(30 ether, type(uint256).max);
        skip(3 days);
        vault.requestUnstake(20 ether, type(uint256).max);
        vm.stopPrank();
        (uint256 amt, uint256 unlock) = vault.pendingUnstake(alice);
        assertEq(amt, 50 ether);
        assertEq(unlock, block.timestamp + CD);
        assertEq(vault.totalPending(), 50 ether);
    }

    function test_requestUnstake_afterMaturityRevertsWithdrawFirst() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(30 ether, type(uint256).max);
        (, uint256 unlock) = vault.pendingUnstake(alice);
        vm.warp(unlock - 1);
        vault.requestUnstake(1 ether, type(uint256).max); // still locked: allowed
        (, uint256 unlock2) = vault.pendingUnstake(alice);
        vm.warp(unlock2);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.WithdrawFirst.selector, unlock2));
        vault.requestUnstake(1 ether, type(uint256).max);
        vault.withdraw();
        vault.requestUnstake(1 ether, type(uint256).max); // fine once withdrawn
        vm.stopPrank();
    }

    /// Regression: a re-request after the owner raised the cooldown must not re-lock
    /// matured funds.
    function test_requestUnstake_rerequestCannotRelockMaturedFunds() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(99 ether, type(uint256).max);
        vm.stopPrank();
        skip(CD);
        vm.prank(owner);
        vault.setCooldown(30 days);
        (, uint256 unlock) = vault.pendingUnstake(alice);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.WithdrawFirst.selector, unlock));
        vault.requestUnstake(1, type(uint256).max);
        vault.withdraw();
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 1_000_000 ether - 1 ether);
    }

    /// Regression: a re-request after the owner lowered the cooldown must not shorten
    /// an existing request.
    function test_requestUnstake_rerequestCannotShortenExisting() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(99 ether, type(uint256).max);
        (, uint256 unlock) = vault.pendingUnstake(alice);
        vm.stopPrank();
        vm.prank(owner);
        vault.setCooldown(0);
        vm.startPrank(alice);
        vault.requestUnstake(1, type(uint256).max);
        (uint256 amt, uint256 unlockAfter) = vault.pendingUnstake(alice);
        assertEq(amt, 99 ether + 1);
        assertEq(unlockAfter, unlock);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.StillLocked.selector, unlock));
        vault.withdraw();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ withdraw + cooldown boundaries

    function test_withdraw_afterCooldown() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(100 ether, type(uint256).max);
        skip(CD);
        vm.expectEmit(true, false, false, true);
        emit Withdrawn(alice, 100 ether);
        vault.withdraw();
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 1_000_000 ether);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalPending(), 0);
        (uint256 amt, uint256 unlock) = vault.pendingUnstake(alice);
        assertEq(amt, 0);
        assertEq(unlock, 0);
    }

    function test_withdraw_oneSecondBeforeUnlockReverts() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(100 ether, type(uint256).max);
        uint256 unlock = block.timestamp + CD;
        vm.warp(unlock - 1);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.StillLocked.selector, unlock));
        vault.withdraw();
        vm.stopPrank();
    }

    function test_withdraw_exactlyAtUnlockWorks() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(100 ether, type(uint256).max);
        vm.warp(block.timestamp + CD);
        vault.withdraw();
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_withdraw_revertsWhenNothingPending() public {
        vm.expectRevert(IWeightVault.NothingPending.selector);
        vm.prank(alice);
        vault.withdraw();
    }

    function test_withdraw_twiceSecondReverts() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(100 ether, type(uint256).max);
        skip(CD);
        vault.withdraw();
        vm.expectRevert(IWeightVault.NothingPending.selector);
        vault.withdraw();
        vm.stopPrank();
    }

    function test_withdraw_leavesStakedUntouched() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(25 ether, type(uint256).max);
        skip(CD);
        vault.withdraw();
        vm.stopPrank();
        assertEq(vault.stakedOf(alice), 75 ether);
        assertEq(token.balanceOf(address(vault)), 75 ether);
    }

    function test_zeroCooldown_withdrawSameBlock() public {
        vm.prank(owner);
        vault.setCooldown(0);
        vm.startPrank(alice);
        vault.stake(10 ether);
        vault.requestUnstake(10 ether, type(uint256).max);
        vault.withdraw();
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 1_000_000 ether);
    }

    // ------------------------------------------------------------ cancelUnstake

    function test_cancelUnstake() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(60 ether, type(uint256).max);
        skip(2 days);
        vm.expectEmit(true, false, false, true);
        emit UnstakeCancelled(alice, 60 ether);
        vault.cancelUnstake();
        vm.stopPrank();

        assertEq(vault.stakedOf(alice), 100 ether);
        assertEq(vault.totalStaked(), 100 ether);
        assertEq(vault.totalPending(), 0);
        (uint256 amt, uint256 unlock) = vault.pendingUnstake(alice);
        assertEq(amt, 0);
        assertEq(unlock, 0);
        // a cancel is a stake increase: age restarts
        assertEq(vault.stakedSince(alice), block.timestamp);
    }

    function test_cancelUnstake_afterUnlockStillWorks() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        vault.requestUnstake(100 ether, type(uint256).max);
        skip(CD + 10 days);
        vault.cancelUnstake();
        vm.stopPrank();
        assertEq(vault.stakedOf(alice), 100 ether);
    }

    function test_cancelUnstake_revertsWhenNothingPending() public {
        vm.expectRevert(IWeightVault.NothingPending.selector);
        vm.prank(alice);
        vault.cancelUnstake();
    }

    // ------------------------------------------------------------ stakedSince anti-cycling

    /// stake -> unstake -> restake does not keep an old age: a fresh stake restarts the clock.
    function test_age_cyclingResetsClock() public {
        vm.startPrank(alice);
        vault.stake(100 ether);
        skip(10 days);
        vault.requestUnstake(100 ether, type(uint256).max);
        assertEq(vault.stakedSince(alice), 0);
        vault.stake(100 ether);
        assertEq(vault.stakedSince(alice), block.timestamp);
        vm.stopPrank();
    }

    /// A user cannot make big money count with old age by topping up: age restarts on any increase.
    function test_age_topUpRestartsClockForWholeBalance() public {
        vm.startPrank(alice);
        vault.stake(1 ether);
        skip(30 days);
        vault.stake(999 ether);
        vm.stopPrank();
        assertEq(vault.stakedSince(alice), block.timestamp);
    }

    // ------------------------------------------------------------ positionOf

    function test_positionOf_matchesIndividualViews() public {
        (uint256 s0, uint256 a0, uint256 p0, uint256 u0) = vault.positionOf(alice);
        assertEq(s0 + a0 + p0 + u0, 0);
        vm.startPrank(alice);
        vault.stake(100 ether);
        skip(1 days);
        vault.requestUnstake(30 ether, type(uint256).max);
        vm.stopPrank();
        (uint256 s, uint256 since, uint256 p, uint256 u) = vault.positionOf(alice);
        (uint256 pa, uint256 pu) = vault.pendingUnstake(alice);
        assertEq(s, vault.stakedOf(alice));
        assertEq(since, vault.stakedSince(alice));
        assertEq(p, pa);
        assertEq(u, pu);
        assertEq(s, 70 ether);
        assertEq(p, 30 ether);
    }

    /// Regression: with separate reads, a top-up between them pairs an old age with a
    /// new amount. positionOf reads one block, so amount and age always belong together.
    function test_positionOf_topUpCannotPairOldAgeWithNewAmount() public {
        vm.prank(alice);
        vault.stake(1);
        skip(2 days);
        vm.prank(alice);
        vault.stake(999_999 ether);
        (uint256 amt, uint256 since,,) = vault.positionOf(alice);
        assertEq(amt, 999_999 ether + 1);
        assertEq(since, block.timestamp, "the large stake is fresh, not 2 days old");
    }

    // ------------------------------------------------------------ owner

    function test_setCooldown() public {
        vm.expectEmit(false, false, false, true);
        emit CooldownUpdated(7 days, 1 days);
        vm.prank(owner);
        vault.setCooldown(1 days);
        assertEq(vault.cooldown(), 1 days);
    }

    function test_setCooldown_maxAllowed_aboveReverts() public {
        vm.startPrank(owner);
        vault.setCooldown(30 days);
        assertEq(vault.cooldown(), 30 days);
        vm.expectRevert(
            abi.encodeWithSelector(IWeightVault.CooldownTooLong.selector, 30 days + 1, 30 days)
        );
        vault.setCooldown(30 days + 1);
        vm.stopPrank();
    }

    function test_setCooldown_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.setCooldown(1);
    }

    function test_setCooldown_doesNotAffectExistingRequest() public {
        vm.startPrank(alice);
        vault.stake(10 ether);
        vault.requestUnstake(10 ether, type(uint256).max);
        vm.stopPrank();
        (, uint256 unlockBefore) = vault.pendingUnstake(alice);

        vm.prank(owner);
        vault.setCooldown(30 days);
        (, uint256 unlockAfter) = vault.pendingUnstake(alice);
        assertEq(unlockAfter, unlockBefore);

        // lowering also does not shorten it
        vm.prank(owner);
        vault.setCooldown(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IWeightVault.StillLocked.selector, unlockBefore));
        vault.withdraw();
    }

    function test_ownership_twoStepAndRenounce() public {
        vm.prank(owner);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), owner); // not yet
        assertEq(vault.pendingOwner(), bob);
        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);

        vm.prank(bob);
        vault.renounceOwnership();
        assertEq(vault.owner(), address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vm.prank(bob);
        vault.setCooldown(1);
        // users are unaffected
        vm.prank(alice);
        vault.stake(1 ether);
    }

    function test_ownerCannotTouchUserFunds() public {
        vm.prank(alice);
        vault.stake(100 ether);
        // the only owner-gated selector is setCooldown (+ Ownable2Step); nothing moves funds.
        vm.startPrank(owner);
        vault.setCooldown(30 days);
        vault.transferOwnership(bob);
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 100 ether);
        assertEq(vault.stakedOf(alice), 100 ether);
    }

    // ------------------------------------------------------------ fee-on-transfer

    function test_feeOnTransfer_creditsReceivedAndStaysSolvent() public {
        FeeToken ft = new FeeToken(500); // 5%
        WeightVault v = new WeightVault(address(ft), owner);
        ft.mint(alice, 1000 ether);
        vm.startPrank(alice);
        ft.approve(address(v), type(uint256).max);
        v.stake(1000 ether);
        assertEq(v.stakedOf(alice), 950 ether);
        assertEq(v.totalStaked(), 950 ether);
        assertEq(ft.balanceOf(address(v)), 950 ether);

        v.requestUnstake(950 ether, type(uint256).max);
        skip(CD);
        v.withdraw(); // user pays the fee again on the way out; vault never short
        vm.stopPrank();
        assertEq(ft.balanceOf(address(v)), 0);
        assertEq(ft.balanceOf(alice), 0 + 902.5 ether);
    }

    function test_feeOnTransfer_manyUsersSolvent() public {
        FeeToken ft = new FeeToken(300);
        WeightVault v = new WeightVault(address(ft), owner);
        ft.mint(alice, 100 ether);
        ft.mint(bob, 100 ether);
        vm.startPrank(alice);
        ft.approve(address(v), type(uint256).max);
        v.stake(100 ether);
        vm.stopPrank();
        vm.startPrank(bob);
        ft.approve(address(v), type(uint256).max);
        v.stake(100 ether);
        v.requestUnstake(97 ether, type(uint256).max);
        skip(CD);
        v.withdraw();
        vm.stopPrank();
        assertGe(ft.balanceOf(address(v)), v.totalStaked() + v.totalPending());
        assertEq(ft.balanceOf(address(v)), v.totalStaked());
    }

    function test_zeroReceivedReverts() public {
        NoopToken nt = new NoopToken();
        WeightVault v = new WeightVault(address(nt), owner);
        vm.expectRevert(IWeightVault.ZeroAmount.selector);
        vm.prank(alice);
        v.stake(1 ether);
    }

    // ------------------------------------------------------------ direct donations

    function test_donationDoesNotChangeAccounting() public {
        vm.prank(alice);
        vault.stake(100 ether);
        vm.prank(bob);
        token.transfer(address(vault), 50 ether);
        assertEq(vault.totalStaked(), 100 ether);
        assertEq(token.balanceOf(address(vault)), 150 ether);
        // withdrawals still pay exactly what was requested
        vm.startPrank(alice);
        vault.requestUnstake(100 ether, type(uint256).max);
        skip(CD);
        vault.withdraw();
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 50 ether);
    }

    // ------------------------------------------------------------ reentrancy

    function _evil() internal returns (ReentrantToken et, WeightVault v) {
        et = new ReentrantToken();
        v = new WeightVault(address(et), owner);
        et.mint(alice, 1000 ether);
        vm.prank(alice);
        et.approve(address(v), type(uint256).max);
    }

    function test_reentrancy_duringStakeTransferFrom_swallowed() public {
        (ReentrantToken et, WeightVault v) = _evil();
        et.mint(alice, 10 ether);
        et.arm(v, ReentrantToken.Mode.Stake, false);
        vm.prank(alice);
        v.stake(100 ether);
        assertEq(et.attempts(), 1);
        assertEq(et.innerReverts(), 1); // inner call blocked
        assertEq(v.stakedOf(alice), 100 ether);
        assertEq(et.balanceOf(address(v)), 100 ether);
    }

    function test_reentrancy_duringStake_bubbledReverts() public {
        (ReentrantToken et, WeightVault v) = _evil();
        et.arm(v, ReentrantToken.Mode.Stake, true);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        v.stake(100 ether);
        assertEq(v.totalStaked(), 0);
    }

    function test_reentrancy_duringWithdrawTransfer_allModes() public {
        ReentrantToken.Mode[4] memory modes = [
            ReentrantToken.Mode.Stake,
            ReentrantToken.Mode.RequestUnstake,
            ReentrantToken.Mode.Withdraw,
            ReentrantToken.Mode.Cancel
        ];
        for (uint256 i; i < modes.length; i++) {
            (ReentrantToken et, WeightVault v) = _evil();
            vm.startPrank(alice);
            v.stake(100 ether);
            v.requestUnstake(100 ether, type(uint256).max);
            skip(CD);
            et.arm(v, modes[i], false);
            v.withdraw();
            vm.stopPrank();
            assertEq(et.attempts(), 1);
            assertEq(et.innerReverts(), 1, "inner call must be blocked");
            assertEq(et.lastInnerRevert(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            assertEq(et.balanceOf(address(v)), 0);
            assertEq(et.balanceOf(alice), 1000 ether);
            assertEq(v.totalPending(), 0);
            assertEq(v.totalStaked(), 0);
        }
    }

    function test_reentrancy_withdrawWithdrawBubbled() public {
        (ReentrantToken et, WeightVault v) = _evil();
        vm.startPrank(alice);
        v.stake(100 ether);
        v.requestUnstake(100 ether, type(uint256).max);
        skip(CD);
        et.arm(v, ReentrantToken.Mode.Withdraw, true);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        v.withdraw();
        vm.stopPrank();
        // state rolled back: user can still withdraw once
        (uint256 amt,) = v.pendingUnstake(alice);
        assertEq(amt, 100 ether);
    }

    /// Checks-effects-interactions: while the vault pays out, the token itself asserts that the
    /// user's pending is already 0 and totalPending already reduced.
    function test_withdraw_stateFinalDuringTransfer() public {
        CeiSpyToken ct = new CeiSpyToken();
        WeightVault v = new WeightVault(address(ct), owner);
        ct.mint(alice, 100 ether);
        ct.mint(bob, 40 ether);
        vm.startPrank(bob);
        ct.approve(address(v), type(uint256).max);
        v.stake(40 ether);
        v.requestUnstake(40 ether, type(uint256).max);
        vm.stopPrank();
        vm.startPrank(alice);
        ct.approve(address(v), type(uint256).max);
        v.stake(100 ether);
        v.requestUnstake(100 ether, type(uint256).max);
        skip(CD);
        ct.arm(address(v), alice, 40 ether); // bob's 40 still pending after alice leaves
        v.withdraw();
        vm.stopPrank();
        assertEq(ct.checks(), 1, "the probe ran");
    }

    /// The same probe fails on a vault that transfers before updating state, so it can catch a
    /// CEI break (the earlier assertion after the call could not).
    function test_withdraw_ceiProbeCatchesMutant() public {
        CeiSpyToken ct = new CeiSpyToken();
        MutantVault m = new MutantVault(address(ct));
        ct.mint(alice, 100 ether);
        vm.startPrank(alice);
        ct.approve(address(m), type(uint256).max);
        m.stake(100 ether);
        m.requestUnstake(100 ether);
        skip(CD);
        ct.arm(address(m), alice, 0);
        vm.expectRevert(bytes("CEI"));
        m.withdraw();
        vm.stopPrank();
    }

    /// Stake path: a hook fired inside transferFrom cannot re-enter any entry point.
    function test_reentrancy_duringStake_allModes() public {
        ReentrantToken.Mode[4] memory modes = [
            ReentrantToken.Mode.Stake,
            ReentrantToken.Mode.RequestUnstake,
            ReentrantToken.Mode.Withdraw,
            ReentrantToken.Mode.Cancel
        ];
        for (uint256 i; i < modes.length; i++) {
            (ReentrantToken et, WeightVault v) = _evil();
            et.arm(v, modes[i], false);
            vm.prank(alice);
            v.stake(100 ether);
            assertEq(et.attempts(), 1);
            assertEq(et.innerReverts(), 1, "inner call must be blocked");
            assertEq(et.lastInnerRevert(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            assertEq(v.stakedOf(alice), 100 ether);
            assertEq(v.totalStaked(), 100 ether);
        }
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_stakeUnstakeWithdraw(uint96 a, uint96 b) public {
        a = uint96(bound(a, 1, 1_000_000 ether));
        b = uint96(bound(b, 1, a));
        vm.startPrank(alice);
        vault.stake(a);
        vault.requestUnstake(b, type(uint256).max);
        assertEq(vault.stakedOf(alice), a - b);
        (uint256 amt,) = vault.pendingUnstake(alice);
        assertEq(amt, b);
        skip(CD);
        vault.withdraw();
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), a - b);
        assertEq(vault.totalStaked(), a - b);
        assertEq(vault.totalPending(), 0);
        assertEq(token.balanceOf(alice), 1_000_000 ether - (a - b));
    }

    function testFuzz_cooldownBoundary(uint256 cd, uint256 elapsed) public {
        cd = bound(cd, 0, 30 days);
        elapsed = bound(elapsed, 0, 60 days);
        vm.prank(owner);
        vault.setCooldown(cd);
        vm.startPrank(alice);
        vault.stake(10 ether);
        vault.requestUnstake(10 ether, type(uint256).max);
        skip(elapsed);
        if (elapsed < cd) {
            vm.expectRevert();
            vault.withdraw();
        } else {
            vault.withdraw();
            assertEq(token.balanceOf(alice), 1_000_000 ether);
        }
        vm.stopPrank();
    }

    function testFuzz_setCooldownBounds(uint256 cd) public {
        vm.prank(owner);
        if (cd > 30 days) {
            vm.expectRevert(
                abi.encodeWithSelector(IWeightVault.CooldownTooLong.selector, cd, 30 days)
            );
            vault.setCooldown(cd);
        } else {
            vault.setCooldown(cd);
            assertEq(vault.cooldown(), cd);
        }
    }

    function testFuzz_feeToken_creditsExactlyReceived(uint16 feeBps, uint96 amt) public {
        feeBps = uint16(bound(feeBps, 0, 10_000 - 1));
        amt = uint96(bound(amt, 10_000, 1_000_000 ether));
        FeeToken ft = new FeeToken(feeBps);
        WeightVault v = new WeightVault(address(ft), owner);
        ft.mint(alice, amt);
        vm.startPrank(alice);
        ft.approve(address(v), amt);
        v.stake(amt);
        vm.stopPrank();
        assertEq(v.stakedOf(alice), ft.balanceOf(address(v)));
        assertEq(v.totalStaked(), ft.balanceOf(address(v)));
    }

    function testFuzz_noOneElseCanTouchMyPosition(address stranger, uint96 amt) public {
        vm.assume(stranger != alice && stranger != address(0) && stranger != address(vault));
        amt = uint96(bound(amt, 1, 1_000_000 ether));
        vm.prank(alice);
        vault.stake(amt);
        vm.startPrank(stranger);
        vm.expectRevert();
        vault.requestUnstake(1, type(uint256).max);
        vm.expectRevert(IWeightVault.NothingPending.selector);
        vault.withdraw();
        vm.expectRevert(IWeightVault.NothingPending.selector);
        vault.cancelUnstake();
        vm.stopPrank();
        assertEq(vault.stakedOf(alice), amt);
    }
}
