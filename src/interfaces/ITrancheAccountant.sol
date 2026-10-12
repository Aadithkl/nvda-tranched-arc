// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ITrancheAccountant {
    function seniorVault() external view returns (address);

    function juniorVault() external view returns (address);

    function seniorClaim() external view returns (uint256);

    function juniorClaim() external view returns (uint256);

    function poolValue() external view returns (uint256);

    function escrowFunded() external view returns (bool);

    /// @notice Minimum junior slice of tranche backing (bps of 10_000), immutable.
    function minJuniorFloorBps() external view returns (uint16);

    /// @notice Advances the withdrawal clock past a 24h boundary (permissionless).
    function executeEpoch() external returns (uint256 id);

    /// @notice Fulfills a user's pending exit at the latest snapshot (permissionless).
    function claimEpoch(bool senior, address user) external;

    function seniorGuaranteeQuote() external view returns (uint256);

    function onTrancheDeposit(bool senior, uint256 hookShares) external;

    function onTrancheRedeem(bool senior, uint256 hookShares) external;

    function onTrancheClaim(bool senior, uint256 hookShares) external;

    function rebalance() external returns (uint256 seniorShares, uint256 juniorShares);
}
