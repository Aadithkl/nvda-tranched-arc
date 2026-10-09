// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IMorpho, IMorphoOracle } from "../adapters/IMorpho.sol";

/// @notice Minimal interest-free Morpho Blue for unit tests. Shares are 1:1 with assets but the
///         virtual-shares conversion is honored (as the real singleton does), and collateral
///         withdrawals / borrows enforce the LLTV against the market oracle.
contract MockMorpho is IMorpho {
    using SafeERC20 for IERC20;

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    mapping(bytes32 => Market) internal _markets;
    mapping(bytes32 => mapping(address => Position)) internal _positions;

    error Unsupported();
    error InsufficientLiquidity();
    error HealthCheck();

    function id(MarketParams memory marketParams) external pure returns (bytes32) {
        return keccak256(abi.encode(marketParams));
    }

    function market(bytes32 id_) external view returns (Market memory) {
        return _markets[id_];
    }

    function position(bytes32 id_, address user) external view returns (uint256, uint128, uint128) {
        Position memory p = _positions[id_][user];
        return (p.supplyShares, p.borrowShares, p.collateral);
    }

    function supply(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory)
        external
    {
        if (shares != 0) revert Unsupported();
        if (onBehalf != msg.sender) revert Unsupported();
        bytes32 id_ = this.id(marketParams);
        Market storage m = _markets[id_];
        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), assets);
        m.totalSupplyAssets += uint128(assets);
        m.totalSupplyShares += uint128(assets);
        _positions[id_][onBehalf].supplyShares += assets;
    }

    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 withdrawnAssets, uint256 withdrawnShares) {
        if (shares != 0) revert Unsupported();
        if (onBehalf != msg.sender) revert Unsupported();
        bytes32 id_ = this.id(marketParams);
        Market storage m = _markets[id_];
        uint256 available = uint256(m.totalSupplyAssets) - uint256(m.totalBorrowAssets);
        if (assets > available) revert InsufficientLiquidity();
        m.totalSupplyAssets -= uint128(assets);
        m.totalSupplyShares -= uint128(assets);
        _positions[id_][onBehalf].supplyShares -= assets;
        IERC20(marketParams.loanToken).safeTransfer(receiver, assets);
        return (assets, assets);
    }

    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory)
        external
    {
        if (onBehalf != msg.sender) revert Unsupported();
        bytes32 id_ = this.id(marketParams);
        IERC20(marketParams.collateralToken).safeTransferFrom(msg.sender, address(this), assets);
        _positions[id_][onBehalf].collateral += uint128(assets);
    }

    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external
    {
        if (onBehalf != msg.sender) revert Unsupported();
        bytes32 id_ = this.id(marketParams);
        Position storage p = _positions[id_][onBehalf];
        uint256 collateralAfter = uint256(p.collateral) - assets;
        _requireHealth(marketParams, collateralAfter, _debtAssets(_markets[id_], p.borrowShares));
        p.collateral = uint128(collateralAfter);
        IERC20(marketParams.collateralToken).safeTransfer(receiver, assets);
    }

    function _debtAssets(Market storage m, uint256 shares) internal view returns (uint256) {
        if (shares == 0) return 0;
        return
            Math.mulDiv(
                shares, uint256(m.totalBorrowAssets) + 1, uint256(m.totalBorrowShares) + 1e6, Math.Rounding.Ceil
            );
    }

    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external {
        if (shares != 0) revert Unsupported();
        if (onBehalf != msg.sender) revert Unsupported();
        bytes32 id_ = this.id(marketParams);
        Market storage m = _markets[id_];
        if (assets > uint256(m.totalSupplyAssets) - uint256(m.totalBorrowAssets)) revert InsufficientLiquidity();
        Position storage p = _positions[id_][onBehalf];
        uint256 newShares = Math.mulDiv(
            assets, uint256(m.totalBorrowShares) + 1e6, uint256(m.totalBorrowAssets) + 1, Math.Rounding.Ceil
        );
        _requireHealth(marketParams, p.collateral, _debtAssets(m, uint256(p.borrowShares) + newShares));
        p.borrowShares += uint128(newShares);
        m.totalBorrowAssets += uint128(assets);
        m.totalBorrowShares += uint128(newShares);
        IERC20(marketParams.loanToken).safeTransfer(receiver, assets);
    }

    function repay(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory)
        external
        returns (uint256 repaidAssets, uint256 repaidShares)
    {
        if (onBehalf != msg.sender) revert Unsupported();
        bytes32 id_ = this.id(marketParams);
        Market storage m = _markets[id_];
        Position storage p = _positions[id_][onBehalf];
        uint256 amount;
        uint256 burnedShares;
        if (shares != 0) {
            burnedShares = shares < uint256(p.borrowShares) ? shares : uint256(p.borrowShares);
            amount = Math.mulDiv(
                burnedShares, uint256(m.totalBorrowAssets) + 1, uint256(m.totalBorrowShares) + 1e6, Math.Rounding.Ceil
            );
        } else {
            burnedShares = assets < uint256(p.borrowShares) ? assets : uint256(p.borrowShares);
            amount = burnedShares;
        }
        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), amount);
        p.borrowShares -= uint128(burnedShares);
        m.totalBorrowAssets -= uint128(amount);
        m.totalBorrowShares -= uint128(burnedShares);
        return (amount, burnedShares);
    }

    function _requireHealth(MarketParams memory marketParams, uint256 collateralAfter, uint256 borrowAssets)
        internal
        view
    {
        if (borrowAssets == 0) return;
        uint256 price = IMorphoOracle(marketParams.oracle).price();
        uint256 collateralValue = Math.mulDiv(collateralAfter, price, 1e36);
        uint256 maxDebt = Math.mulDiv(collateralValue, marketParams.lltv, 1e18);
        if (borrowAssets > maxDebt) revert HealthCheck();
    }
}
