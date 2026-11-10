// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IWeightVault
/// @notice Interface of the Freeweight staking vault. Stake the token, earn off-chain daily rent
///         credits. The vault itself pays nothing: the gateway reads these views and computes credits.
interface IWeightVault {
    // ---------------------------------------------------------------- errors
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientStaked(uint256 requested, uint256 available);
    error NothingPending();
    error StillLocked(uint256 unlockTime);
    /// @dev A matured request is pending: withdraw it before requesting again.
    error WithdrawFirst(uint256 unlockTime);
    error CooldownTooLong(uint256 requested, uint256 max);
    /// @dev The current cooldown is longer than the longest the caller accepts.
    error CooldownAboveMax(uint256 cooldown, uint256 maxCooldown);

    // ---------------------------------------------------------------- events
    /// @param amount the amount actually received by the vault (balance delta)
    event Staked(address indexed user, uint256 amount, uint256 newStaked);
    /// @param amount the amount added to the user's pending balance by this request
    /// @param unlockTime when ALL of the user's pending tokens (not only `amount`) can be withdrawn
    event UnstakeRequested(address indexed user, uint256 amount, uint256 unlockTime);
    event UnstakeCancelled(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    // ---------------------------------------------------------------- user actions
    function stake(uint256 amount) external;
    function requestUnstake(uint256 amount, uint256 maxCooldown) external;
    function cancelUnstake() external;
    function withdraw() external;

    // ---------------------------------------------------------------- gateway views
    /// @notice Amount that counts as staked: excludes anything in cooldown.
    function stakedOf(address user) external view returns (uint256);
    /// @notice Sum of every user's counted stake.
    function totalStaked() external view returns (uint256);
    /// @notice Amount in cooldown and the time it can be withdrawn (0, 0 if none).
    function pendingUnstake(address user) external view returns (uint256 amount, uint256 unlockTime);
    /// @notice Timestamp of the user's latest increase of counted stake (stake or cancelUnstake);
    ///         0 when nothing is staked. Credits should count only if now - stakedSince >= minAge.
    function stakedSince(address user) external view returns (uint256);
    /// @notice One-call snapshot of a user's position; the gateway should use this (at one pinned
    ///         block) instead of separate calls, so amount and age always belong together.
    /// @return staked same as stakedOf
    /// @return since same as stakedSince
    /// @return pending same as pendingUnstake().amount
    /// @return unlockTime same as pendingUnstake().unlockTime
    function positionOf(address user)
        external
        view
        returns (uint256 staked, uint256 since, uint256 pending, uint256 unlockTime);
    /// @notice Sum of every user's pending (cooldown) amount.
    function totalPending() external view returns (uint256);
    /// @notice Cooldown applied to future unstake requests, in seconds.
    function cooldown() external view returns (uint256);
    /// @notice The staked token (immutable).
    function token() external view returns (address);
}
