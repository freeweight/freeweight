// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {WeightVault} from "../src/WeightVault.sol";

/// @notice Deploys WeightVault. NOT run by the build; a manual owner step (see README).
///         Env: WEIGHT_TOKEN (required, the ERC-20 address), VAULT_OWNER (required, the owner).
///         The signer is supplied on the command line (--account / --ledger), never stored here.
contract Deploy is Script {
    function run() external returns (WeightVault vault) {
        address token = vm.envAddress("WEIGHT_TOKEN");
        address owner = vm.envAddress("VAULT_OWNER");
        require(token.code.length > 0, "WEIGHT_TOKEN has no code on this chain");

        vm.startBroadcast();
        vault = new WeightVault(token, owner);
        vm.stopBroadcast();

        console2.log("WeightVault", address(vault));
        console2.log("token", token);
        console2.log("owner", owner);
    }
}
