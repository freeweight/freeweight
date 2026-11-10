// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {WeightVault} from "../../src/WeightVault.sol";

/// @dev Plain mintable ERC-20 standing in for $WEIGHT.
contract MockToken is ERC20 {
    constructor() ERC20("Weight", "WEIGHT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns `feeBps` of every transfer (the recipient gets less than the amount sent).
contract FeeToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Fee", "FEE") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Token that calls back into the vault in the middle of a transfer (ERC-777 style hook).
contract ReentrantToken is ERC20 {
    enum Mode {
        Off,
        Stake,
        RequestUnstake,
        Withdraw,
        Cancel
    }

    WeightVault public vault;
    Mode public mode;
    bool public bubble; // true: bubble the inner revert; false: swallow it
    uint256 public attempts;
    uint256 public innerReverts;

    constructor() ERC20("Evil", "EVIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(WeightVault v, Mode m, bool bubble_) external {
        vault = v;
        mode = m;
        bubble = bubble_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // fire the hook only on transfers touching the vault
        if (
            mode != Mode.Off && address(vault) != address(0)
                && (from == address(vault) || to == address(vault))
        ) {
            Mode m = mode;
            mode = Mode.Off; // one shot
            attempts++;
            bytes memory data;
            if (m == Mode.Stake) data = abi.encodeCall(vault.stake, (1));
            else if (m == Mode.RequestUnstake) data = abi.encodeCall(vault.requestUnstake, (1));
            else if (m == Mode.Withdraw) data = abi.encodeCall(vault.withdraw, ());
            else data = abi.encodeCall(vault.cancelUnstake, ());
            (bool ok, bytes memory ret) = address(vault).call(data);
            if (!ok) {
                innerReverts++;
                if (bubble) {
                    assembly ("memory-safe") {
                        revert(add(ret, 32), mload(ret))
                    }
                }
            }
        }
    }
}

/// @dev Token whose transferFrom reports success but moves nothing (to prove zero-receipt reverts).
contract NoopToken is ERC20 {
    constructor() ERC20("Noop", "NOOP") {}

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return true;
    }
}
