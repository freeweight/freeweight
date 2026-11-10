// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {WeightVault} from "../src/WeightVault.sol";
import {MockToken} from "./mocks/Mocks.sol";

/// @dev Drives the vault with random actors/actions/time jumps and tracks ghost totals.
contract VaultHandler is Test {
    WeightVault public vault;
    MockToken public token;
    address public owner;
    address[] public actors;

    uint256 public ghostIn; // tokens put in via stake
    uint256 public ghostOut; // tokens paid out via withdraw

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
        vm.prank(a);
        vault.stake(amt);
        ghostIn += amt;
    }

    function requestUnstake(uint256 who, uint256 amt) external {
        address a = actors[who % actors.length];
        uint256 s = vault.stakedOf(a);
        if (s == 0) return;
        amt = bound(amt, 1, s);
        vm.prank(a);
        vault.requestUnstake(amt);
    }

    function cancelUnstake(uint256 who) external {
        address a = actors[who % actors.length];
        (uint256 p,) = vault.pendingUnstake(a);
        if (p == 0) return;
        vm.prank(a);
        vault.cancelUnstake();
    }

    function withdraw(uint256 who) external {
        address a = actors[who % actors.length];
        (uint256 p, uint256 unlock) = vault.pendingUnstake(a);
        if (p == 0 || block.timestamp < unlock) return;
        vm.prank(a);
        vault.withdraw();
        ghostOut += p;
    }

    function setCooldown(uint256 cd) external {
        vm.prank(owner);
        vault.setCooldown(bound(cd, 0, 30 days));
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 0, 10 days));
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

    /// vault token balance == totalStaked + totalPending (no donations in this model)
    function invariant_balanceMatchesTotals() public view {
        assertEq(token.balanceOf(address(vault)), vault.totalStaked() + vault.totalPending());
    }

    /// sum of users == totals
    function invariant_userSumsMatchTotals() public view {
        assertEq(handler.sumStaked(), vault.totalStaked());
        assertEq(handler.sumPending(), vault.totalPending());
    }

    /// conservation: everything that went in and has not come out is still in the vault
    function invariant_conservation() public view {
        assertEq(handler.ghostIn() - handler.ghostOut(), token.balanceOf(address(vault)));
    }

    /// cooldown never exceeds the hard bound
    function invariant_cooldownBounded() public view {
        assertLe(vault.cooldown(), 30 days);
    }

    /// stakedSince is set iff something is staked
    function invariant_stakedSinceIffStaked() public view {
        for (uint256 i; i < handler.actorsLength(); i++) {
            address a = handler.actors(i);
            assertEq(vault.stakedOf(a) == 0, vault.stakedSince(a) == 0);
            (uint256 p, uint256 unlock) = vault.pendingUnstake(a);
            assertEq(p == 0, unlock == 0);
        }
    }
}
