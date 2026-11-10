// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
    bytes4 public lastInnerRevert; // selector of the last swallowed inner revert

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
            if (m == Mode.Stake) {
                data = abi.encodeCall(vault.stake, (1));
            } else if (m == Mode.RequestUnstake) {
                data = abi.encodeCall(vault.requestUnstake, (1, type(uint256).max));
            } else if (m == Mode.Withdraw) {
                data = abi.encodeCall(vault.withdraw, ());
            } else {
                data = abi.encodeCall(vault.cancelUnstake, ());
            }
            (bool ok, bytes memory ret) = address(vault).call(data);
            if (!ok) {
                innerReverts++;
                lastInnerRevert = bytes4(ret);
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

/// @dev Token with an owner-controlled blocklist (USDC/USDT style).
contract BlocklistToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Block", "BLK") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 v) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, v);
    }
}

/// @dev Token that, mid-transfer, snapshots the vault views an on-chain reader would see.
contract SpyToken is ERC20 {
    WeightVault public vault;
    address public user;
    bool public armed;
    uint256 public seenStaked;
    uint256 public seenPending;
    uint256 public seenTotalStaked;
    uint256 public seenTotalPending;
    uint256 public seenBalance;
    uint256 public seenSince;

    constructor() ERC20("Spy", "SPY") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(WeightVault v, address u) external {
        vault = v;
        user = u;
        armed = true;
    }

    function _update(address from, address to, uint256 v) internal override {
        super._update(from, to, v);
        if (armed && (from == address(vault) || to == address(vault))) {
            armed = false;
            seenStaked = vault.stakedOf(user);
            (seenPending,) = vault.pendingUnstake(user);
            seenTotalStaked = vault.totalStaked();
            seenTotalPending = vault.totalPending();
            seenBalance = balanceOf(address(vault));
            seenSince = vault.stakedSince(user);
        }
    }
}

/// @dev Checks-effects-interactions probe: when the vault pays out, the token asserts that the
///      vault's accounting is ALREADY final (user's pending == 0 and totalPending == `expectTotal`).
///      Reverts "CEI" otherwise, so a vault that transfers before updating state fails its test.
contract CeiSpyToken is ERC20 {
    address public target;
    address public user;
    uint256 public expectTotal;
    bool public armed;
    uint256 public checks;

    constructor() ERC20("Cei", "CEI") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(address target_, address user_, uint256 expectTotal_) external {
        target = target_;
        user = user_;
        expectTotal = expectTotal_;
        armed = true;
    }

    function _update(address from, address to, uint256 v) internal override {
        if (armed && from == target && to == user) {
            armed = false;
            checks++;
            (bool ok, bytes memory r) =
                target.staticcall(abi.encodeWithSignature("pendingUnstake(address)", user));
            (uint256 pend,) = abi.decode(r, (uint256, uint256));
            (bool ok2, bytes memory r2) =
                target.staticcall(abi.encodeWithSignature("totalPending()"));
            require(ok && ok2 && pend == 0 && abi.decode(r2, (uint256)) == expectTotal, "CEI");
        }
        super._update(from, to, v);
    }
}

/// @dev Mutant of withdraw with checks-effects-interactions BROKEN (transfer first, state after).
///      Used only to prove the CEI test can fail.
contract MutantVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable tok;
    uint256 public totalPending;
    mapping(address => uint256) public staked;
    mapping(address => uint256) public pending;
    mapping(address => uint256) public unlockAt;

    constructor(address t) {
        tok = IERC20(t);
    }

    function pendingUnstake(address u) external view returns (uint256, uint256) {
        return (pending[u], unlockAt[u]);
    }

    function stake(uint256 a) external nonReentrant {
        tok.safeTransferFrom(msg.sender, address(this), a);
        staked[msg.sender] += a;
    }

    function requestUnstake(uint256 a) external nonReentrant {
        staked[msg.sender] -= a;
        pending[msg.sender] += a;
        totalPending += a;
        unlockAt[msg.sender] = block.timestamp + 7 days;
    }

    function withdraw() external nonReentrant {
        uint256 a = pending[msg.sender];
        require(a > 0 && block.timestamp >= unlockAt[msg.sender]);
        tok.safeTransfer(msg.sender, a); // INTERACTION FIRST (mutation)
        pending[msg.sender] = 0;
        totalPending -= a;
    }
}
