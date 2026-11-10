// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {WeightVault} from "../src/WeightVault.sol";

/// @notice Deploys WeightVault. NOT run by the build; a manual owner step (see README).
///         Env:
///         - WEIGHT_TOKEN (required): the ERC-20 address.
///         - VAULT_OWNER (required): the owner; not the deployer by default, so no handover step.
///         - VAULT_CHAIN_ID (optional, default 4663): the chain id this deployment must run on.
///           Override it only for a testnet.
///         - VAULT_OWNER_IS_CONTRACT (optional, default false): set true when the owner is a Safe or
///           other contract; the script then requires code at the owner address on this chain. A
///           Safe that is not deployed here would leave the cooldown frozen, silently.
///         The signer is supplied on the command line (--account / --ledger), never stored here.
contract Deploy is Script {
    function run() external returns (WeightVault vault) {
        address token = vm.envAddress("WEIGHT_TOKEN");
        address owner = vm.envAddress("VAULT_OWNER");
        uint256 expectedChain = vm.envOr("VAULT_CHAIN_ID", uint256(4663));
        require(block.chainid == expectedChain, "wrong chain id");
        require(token.code.length > 0, "WEIGHT_TOKEN has no code on this chain");
        if (vm.envOr("VAULT_OWNER_IS_CONTRACT", false)) {
            require(owner.code.length > 0, "VAULT_OWNER has no code on this chain");
        }

        // Eyeball these before broadcasting: the right token?
        console2.log("token symbol", IERC20Metadata(token).symbol());
        console2.log("token decimals", uint256(IERC20Metadata(token).decimals()));

        vm.startBroadcast();
        vault = new WeightVault(token, owner);
        vm.stopBroadcast();

        console2.log("WeightVault", address(vault));
        console2.log("token", token);
        console2.log("owner", owner);
    }
}
