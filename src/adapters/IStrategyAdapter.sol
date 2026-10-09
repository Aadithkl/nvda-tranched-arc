// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Fixed-function strategy adapter. Only the owning authority (the StrategyModule) may
///         move funds; every value is reported in `asset()` units for onchain NAV aggregation.
interface IStrategyAdapter {
    error NotAuthority(address caller);
    error ZeroAmount();
    error ZeroAddress();

    /// @notice The StrategyModule allowed to call this adapter.
    function authority() external view returns (address);

    /// @notice Accounting asset (the vault's quote unit, e.g. USDG).
    function asset() external view returns (address);

    /// @notice Current value held by the adapter, in asset units.
    function realAssets() external view returns (uint256);

    /// @notice Amount that could be returned immediately (liquidity-aware).
    function maxWithdrawable() external view returns (uint256);

    /// @notice Pulls `amount` of asset from the authority and deploys it. Returns amount deployed.
    function deposit(uint256 amount) external returns (uint256 deployed);

    /// @notice Withdraws up to `amount` of asset and sends it to `to`. Returns amount withdrawn.
    function withdraw(uint256 amount, address to) external returns (uint256 withdrawn);

    /// @notice Best-effort full unwind: everything (including loop debt) back to `to`, in-kind.
    ///         Returns the amount of `asset()` returned; collateral (if any) goes to `to` as well.
    function exit(uint256 amount, address to) external returns (uint256 withdrawn);
}
