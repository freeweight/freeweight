// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WeightVault} from "../src/WeightVault.sol";

/// @notice Deployment gate, skipped in a normal `forge test`. Run it against the REAL token on a
///         fork before the vault is announced, and again after the token's launchpad phase changes
///         (some launchpad tokens restrict transfers before graduation):
///
///         WEIGHT_TOKEN=0x... forge test --match-test test_fork_roundTrip --fork-url $RH_RPC -vv
///
///         It stakes, requests, waits out the cooldown and withdraws, and asserts the exact amounts,
///         so a fee, a blocklist or a transfer restriction shows up here and not in production.
contract ForkTest is Test {
    function test_fork_roundTrip() public {
        address tokenAddr = vm.envOr("WEIGHT_TOKEN", address(0));
        if (tokenAddr == address(0)) vm.skip(true);
        IERC20 token = IERC20(tokenAddr);
        require(tokenAddr.code.length > 0, "no token code on this fork");

        address owner = makeAddr("owner");
        address user = makeAddr("user");
        WeightVault vault = new WeightVault(tokenAddr, owner);

        uint256 amount = 1000 * 10 ** vm.envOr("WEIGHT_DECIMALS", uint256(18));
        deal(tokenAddr, user, amount);
        uint256 before = token.balanceOf(user);
        assertEq(before, amount, "deal did not fund the user");

        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.stake(amount);
        assertEq(vault.stakedOf(user), amount, "vault credited less than sent: fee on transfer?");
        assertEq(token.balanceOf(address(vault)), amount);

        vault.requestUnstake(amount, type(uint256).max);
        skip(vault.cooldown());
        vault.withdraw();
        vm.stopPrank();

        assertEq(token.balanceOf(user), before, "round trip lost tokens");
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalStaked() + vault.totalPending(), 0);
    }
}
