// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Vault-facing surface of the StrategyModule (external calls only; keeps RegimeVault lean).
interface IStrategyModule {
    function totalAssets() external view returns (uint256);

    function allocate(address adapter, uint256 amount) external;

    function deallocate(address adapter, uint256 amount) external;

    /// @notice Moves up to `amount` back to the vault using redemption-safe adapters only.
    function pullToVault(uint256 amount) external returns (uint256 pulled);

    /// @notice Best-effort full unwind of every enabled adapter to the vault.
    function exitAll() external;

    function allocateCollateral(address adapter, uint256 amount) external;

    function borrow(address adapter, uint256 amount) external;

    function repay(address adapter, uint256 amount) external;

    function deleverage(address adapter, uint256 repayAmount, uint256 withdrawCollateral) external;

    /// @notice Outstanding loop-sleeve debt across enabled loop adapters (asset units).
    function totalLoopDebt() external view returns (uint256);
}

/// @notice View the vault exposes to the module for relative-cap math and expiry gating.
interface IVaultBaseAssets {
    function baseManagedAssets() external view returns (uint256);

    function expired() external view returns (bool);
}
