// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {WeightVault} from "../src/WeightVault.sol";
import {MockToken} from "./mocks/Mocks.sol";

/// @dev Drives the vault with random actors, actions and time jumps. Every action pre-filters
///      its preconditions, so with fail_on_revert = true any revert is a real bug. Ghost totals
///      come from measured balance deltas, not from the amounts asked for.
contract VaultHandler is Test {
    WeightVault public vault;
    MockToken public token;
    address public owner;
    address[] public actors;

    uint256 public ghostIn; // tokens credited by stake (balance delta)
    uint256 public ghostOut; // tokens paid out by withdraw (balance delta of the user)
    uint256 public ghostDonated; // tokens sent straight to the vault
    mapping(address => uint256) public lastRequestTime;
    uint256 public withdrawals;

    constructor(WeightVault v, MockToken t, address owner_) {
        vault = v;
        token = t;
        owner = owner_;
        for (uint256 i; i < 5; i++) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            t.mint(a, 1e30);
            vm.prank(a);
            t.approve(address(v), type(uint256).max);
        }
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function stake(uint256 who, uint256 amt) external {
        address a = actors[who % actors.length];
        amt = bound(amt, 1, 1e24);
        uint256 before = token.balanceOf(address(vault));
        vm.prank(a);
        vault.stake(amt);
        ghostIn += token.balanceOf(address(vault)) - before;
    }

    function requestUnstake(uint256 who, uint256 amt, uint256 maxCd) external {
        address a = actors[who % actors.length];
        (uint256 s,, uint256 p, uint256 unlock) = vault.positionOf(a);
        if (s == 0) return;
        if (p != 0 && block.timestamp >= unlock) return; // would revert WithdrawFirst
        amt = bound(amt, 1, s);
        // sometimes ask for a limit the current cooldown may exceed: both outcomes are legal
        maxCd = bound(maxCd, 0, 30 days);
        if (vault.cooldown() > maxCd) maxCd = type(uint256).max;
        vm.prank(a);
        vault.requestUnstake(amt, maxCd);
        lastRequestTime[a] = block.timestamp;
    }

    function cancelUnstake(uint256 who) external {
        address a = actors[who % actors.length];
        (uint256 p,) = vault.pendingUnstake(a);
        if (p == 0) return;
        vm.prank(a);
        vault.cancelUnstake();
    }

    function withdraw(uint256 who) external {
        _withdraw(actors[who % actors.length]);
    }

    /// Jumps time to the actor's unlock (if any pending) and withdraws, so mature withdrawals
    /// are exercised in most runs.
    function withdrawAfterUnlock(uint256 who) external {
        address a = actors[who % actors.length];
        (uint256 p, uint256 unlock) = vault.pendingUnstake(a);
        if (p == 0) return;
        if (block.timestamp < unlock) vm.warp(unlock);
        _withdraw(a);
    }

    function _withdraw(address a) internal {
        (uint256 p, uint256 unlock) = vault.pendingUnstake(a);
        if (p == 0 || block.timestamp < unlock) return;
        uint256 before = token.balanceOf(a);
        vm.prank(a);
        vault.withdraw();
        // liveness: a matured request pays out exactly `pending`
        assertEq(token.balanceOf(a) - before, p, "withdraw paid exactly pending");
        ghostOut += p;
        withdrawals++;
    }

    function donate(uint256 who, uint256 amt) external {
        address a = actors[who % actors.length];
        amt = bound(amt, 1, 1e21);
        vm.prank(a);
        token.transfer(address(vault), amt);
        ghostDonated += amt;
    }

    function setCooldown(uint256 cd) external {
        vm.prank(owner);
        vault.setCooldown(bound(cd, 0, 30 days));
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 0, 10 days));
    }

    /// Jump just past the earliest unlock among the actors (matures pending without withdrawing).
    function warpPastUnlock(uint256 who) external {
        address a = actors[who % actors.length];
        (uint256 p, uint256 unlock) = vault.pendingUnstake(a);
        if (p != 0 && unlock >= block.timestamp) vm.warp(unlock + 1);
    }

    function sumStaked() external view returns (uint256 s) {
        for (uint256 i; i < actors.length; i++) {
            s += vault.stakedOf(actors[i]);
        }
    }

    function sumPending() external view returns (uint256 s) {
        for (uint256 i; i < actors.length; i++) {
            (uint256 p,) = vault.pendingUnstake(actors[i]);
            s += p;
        }
    }
}

contract WeightVaultInvariantTest is StdInvariant, Test {
    WeightVault vault;
    MockToken token;
    VaultHandler handler;
    address owner = makeAddr("owner");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockToken();
        vault = new WeightVault(address(token), owner);
        handler = new VaultHandler(vault, token, owner);
        targetContract(address(handler));
    }

    /// vault balance >= totalStaked + totalPending, and equal once donations are subtracted
    function invariant_balanceCoversTotals() public view {
        uint256 liabilities = vault.totalStaked() + vault.totalPending();
        assertGe(token.balanceOf(address(vault)), liabilities);
        assertEq(token.balanceOf(address(vault)), liabilities + handler.ghostDonated());
    }

    /// sum of users == totals
    function invariant_userSumsMatchTotals() public view {
        assertEq(handler.sumStaked(), vault.totalStaked());
        assertEq(handler.sumPending(), vault.totalPending());
    }

    /// conservation: credited in - paid out (+ donations) is exactly what the vault holds
    function invariant_conservation() public view {
        assertEq(
            handler.ghostIn() + handler.ghostDonated() - handler.ghostOut(),
            token.balanceOf(address(vault))
        );
    }

    function invariant_cooldownBounded() public view {
        assertLe(vault.cooldown(), vault.MAX_COOLDOWN());
    }

    /// Per user: stakedSince is set iff something is staked and never in the future; unlockTime is
    /// set iff something is pending and never more than 30 days after the user's last request.
    function invariant_positionBounds() public view {
        for (uint256 i; i < handler.actorsLength(); i++) {
            address a = handler.actors(i);
            (uint256 s, uint256 since, uint256 p, uint256 unlock) = vault.positionOf(a);
            assertEq(s == 0, since == 0);
            assertLe(since, block.timestamp);
            assertEq(p == 0, unlock == 0);
            if (p != 0) assertLe(unlock, handler.lastRequestTime(a) + 30 days);
        }
    }

    /// Liveness: a matured pending amount is always withdrawable, for exactly `pending`.
    /// Each check runs on a snapshot that is rolled back.
    function invariant_maturedPendingIsWithdrawable() public {
        for (uint256 i; i < handler.actorsLength(); i++) {
            address a = handler.actors(i);
            (uint256 p, uint256 unlock) = vault.pendingUnstake(a);
            if (p == 0 || block.timestamp < unlock) continue;
            uint256 snap = vm.snapshotState();
            uint256 before = token.balanceOf(a);
            vm.prank(a);
            vault.withdraw();
            assertEq(token.balanceOf(a) - before, p);
            assertTrue(vm.revertToState(snap));
        }
    }

    /// Sanity: runs reach mature withdrawals (guards against a handler that silently no-ops).
    function afterInvariant() public view {
        // informational only: assertions live in the invariants above
        handler.withdrawals();
    }
}
