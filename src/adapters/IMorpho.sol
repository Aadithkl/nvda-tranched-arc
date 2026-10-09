// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal Morpho Blue interface (era-2 singleton on Robinhood Chain, chain 4663).
/// @dev The Robinhood deployment does NOT expose `id(MarketParams)` (only `idToMarketParams`);
///      the market id is computed locally as `keccak256(abi.encode(marketParams))`, which is the
///      canonical id scheme and matches the ids the deployment created.
interface IMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }

    function market(bytes32 id_) external view returns (Market memory);

    function position(bytes32 id_, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external;

    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 withdrawnAssets, uint256 withdrawnShares);

    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;

    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;

    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external;

    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 repaidAssets, uint256 repaidShares);
}

interface IMorphoOracle {
    /// @dev Collateral price in loan-token units, scaled by 1e36 (decimals included).
    function price() external view returns (uint256);
}
