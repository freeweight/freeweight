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
    error CooldownTooLong(uint256 requested, uint256 max);

    // ---------------------------------------------------------------- events
    /// @param amount the amount actually received by the vault (balance delta)
    event Staked(address indexed user, uint256 amount, uint256 newStaked);
    event UnstakeRequested(address indexed user, uint256 amount, uint256 unlockTime);
    event UnstakeCancelled(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    // ---------------------------------------------------------------- user actions
    function stake(uint256 amount) external;
    function requestUnstake(uint256 amount) external;
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
    /// @notice Sum of every user's pending (cooldown) amount.
    function totalPending() external view returns (uint256);
    /// @notice Cooldown applied to future unstake requests, in seconds.
    function cooldown() external view returns (uint256);
    /// @notice The staked token (immutable).
    function token() external view returns (address);
}
