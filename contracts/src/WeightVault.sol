// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IWeightVault} from "./IWeightVault.sol";

/// @title WeightVault
/// @notice Stake $WEIGHT to earn daily rent credits. Credits are computed off-chain by the
///         Freeweight gateway from the views below; this contract pays no rewards, charges no
///         fee, has no pause, no upgrade path and no way for anyone to move user funds.
/// @dev Accounting: each user has `staked` (counts) and `pending` (in cooldown, does not count).
///      Invariant: token.balanceOf(vault) >= totalStaked + totalPending (equal unless tokens are
///      sent to the vault directly, which are unrecoverable by design).
///      Owner power is limited to `setCooldown` within [0, 30 days]; it never touches existing
///      requests: a later request can only keep or extend the unlock, never shorten it.
contract WeightVault is IWeightVault, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Hard upper bound for the cooldown.
    uint256 public constant MAX_COOLDOWN = 30 days;
    /// @notice Cooldown at deployment.
    uint256 public constant DEFAULT_COOLDOWN = 7 days;

    struct Position {
        uint256 staked;
        uint256 pending;
        uint64 stakedSince; // latest time counted stake increased; 0 if staked == 0
        uint64 unlockTime; // when `pending` can be withdrawn; 0 if pending == 0
    }

    IERC20 private immutable _token;

    uint256 public override cooldown = DEFAULT_COOLDOWN;
    uint256 public override totalStaked;
    uint256 public override totalPending;

    mapping(address => Position) private _positions;

    /// @param token_ the staked token (plain ERC-20), fixed forever
    /// @param owner_ the initial owner (may later renounce or hand over via two steps)
    constructor(address token_, address owner_) Ownable(owner_) {
        if (token_ == address(0)) revert ZeroAddress();
        _token = IERC20(token_);
    }

    // ------------------------------------------------------------------ user actions

    /// @notice Stake `amount` of the token. Credits the balance actually received, so
    ///         fee-on-transfer tokens cannot over-credit. Restarts the user's `stakedSince`.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = _token.balanceOf(address(this));
        _token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = _token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        Position storage p = _positions[msg.sender];
        p.staked += received;
        // forge-lint: disable-next-line(unsafe-typecast)
        p.stakedSince = uint64(block.timestamp);
        totalStaked += received;
        emit Staked(msg.sender, received, p.staked);
    }

    /// @notice Move `amount` of counted stake into cooldown. It stops counting immediately and can
    ///         be withdrawn once the cooldown (as of now) has passed. Requesting again while
    ///         something is still locked adds to the pending amount and moves the unlock of ALL
    ///         pending tokens to `max(old unlock, now + cooldown)`: a request is never shortened.
    ///         `maxCooldown` is the longest cooldown the caller accepts: if the owner has raised the
    ///         cooldown above it (even in the same block), the call reverts `CooldownAboveMax`.
    ///         If the pending amount has already matured, this reverts `WithdrawFirst`, so matured
    ///         funds are never re-locked by surprise.
    function requestUnstake(uint256 amount, uint256 maxCooldown) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (cooldown > maxCooldown) revert CooldownAboveMax(cooldown, maxCooldown);
        Position storage p = _positions[msg.sender];
        if (amount > p.staked) revert InsufficientStaked(amount, p.staked);
        if (p.pending != 0 && block.timestamp >= p.unlockTime) revert WithdrawFirst(p.unlockTime);

        p.staked -= amount;
        if (p.staked == 0) p.stakedSince = 0;
        p.pending += amount;
        uint256 unlock = block.timestamp + cooldown;
        if (unlock < p.unlockTime) unlock = p.unlockTime; // never shortens an existing request
        // forge-lint: disable-next-line(unsafe-typecast)
        p.unlockTime = uint64(unlock);
        totalStaked -= amount;
        totalPending += amount;
        emit UnstakeRequested(msg.sender, amount, unlock);
    }

    /// @notice Put everything in cooldown back into counted stake. Counts as a stake increase, so
    ///         `stakedSince` restarts.
    function cancelUnstake() external nonReentrant {
        Position storage p = _positions[msg.sender];
        uint256 amount = p.pending;
        if (amount == 0) revert NothingPending();

        p.pending = 0;
        p.unlockTime = 0;
        p.staked += amount;
        // forge-lint: disable-next-line(unsafe-typecast)
        p.stakedSince = uint64(block.timestamp);
        totalPending -= amount;
        totalStaked += amount;
        emit UnstakeCancelled(msg.sender, amount);
    }

    /// @notice Withdraw everything in cooldown once `unlockTime` has been reached.
    function withdraw() external nonReentrant {
        Position storage p = _positions[msg.sender];
        uint256 amount = p.pending;
        if (amount == 0) revert NothingPending();
        if (block.timestamp < p.unlockTime) revert StillLocked(p.unlockTime);

        p.pending = 0;
        p.unlockTime = 0;
        totalPending -= amount;
        emit Withdrawn(msg.sender, amount);
        _token.safeTransfer(msg.sender, amount);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Set the cooldown for FUTURE unstake requests (0 to 30 days). Existing requests keep
    ///         the unlock time they were given.
    function setCooldown(uint256 newCooldown) external onlyOwner {
        if (newCooldown > MAX_COOLDOWN) revert CooldownTooLong(newCooldown, MAX_COOLDOWN);
        emit CooldownUpdated(cooldown, newCooldown);
        cooldown = newCooldown;
    }

    // ------------------------------------------------------------------ views

    function stakedOf(address user) external view returns (uint256) {
        return _positions[user].staked;
    }

    function pendingUnstake(address user)
        external
        view
        returns (uint256 amount, uint256 unlockTime)
    {
        Position storage p = _positions[user];
        return (p.pending, p.unlockTime);
    }

    function stakedSince(address user) external view returns (uint256) {
        return _positions[user].stakedSince;
    }

    function token() external view returns (address) {
        return address(_token);
    }
}
