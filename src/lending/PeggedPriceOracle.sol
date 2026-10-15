// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IPriceOracleGetter } from "./interfaces/IPriceOracleGetter.sol";

contract PeggedPriceOracle is Ownable2Step, IPriceOracleGetter {
    uint256 public constant BASE_CURRENCY_UNIT = 1e8;
    bytes32 public constant BASE_CURRENCY = "USD";
    /// @notice Owner-priced oracle with timelocked updates: an instant print-and-reset
    ///         (e.g. `1_000_000e8`, borrow the pool, then reset) cannot clear in one
    ///         transaction. Updates wait out the timelock with a per-update deviation bound.
    uint256 public constant PRICE_TIMELOCK = 24 hours;
    uint256 public constant MAX_DEVIATION_BPS = 2_000; // 20% per update
    uint256 internal constant BPS = 10_000;

    mapping(address => uint256) private _prices;
    mapping(address => uint256) private _updatedAt;

    struct PendingPrice {
        uint256 price;
        uint64 executableAt;
    }
    mapping(address => PendingPrice) public pendingPrices;

    event AssetPriceUpdated(address indexed asset, uint256 price);
    event AssetPriceSubmitted(address indexed asset, uint256 price, uint64 executableAt);
    event AssetPriceCancelled(address indexed asset);

    error PriceNotSet(address asset);
    error InvalidPrice(uint256 price);
    error LengthMismatch();
    error NothingPending(address asset);
    error TimelockActive(uint64 executableAt);
    error DeviationTooLarge(uint256 oldPrice, uint256 newPrice);

    constructor(address owner_) Ownable(owner_) { }

    /// @notice Schedules a price update. The FIRST price for an asset seeds
    ///         immediately (deploy bootstrap — no liquidity exists to borrow against
    ///         yet); every CHANGE waits out the timelock + deviation bound at execute.
    function setAssetPrice(address asset, uint256 price) external onlyOwner {
        if (price == 0) revert InvalidPrice(price);
        if (_prices[asset] == 0) {
            _prices[asset] = price;
            _updatedAt[asset] = block.timestamp;
            emit AssetPriceUpdated(asset, price);
        } else {
            pendingPrices[asset] =
                PendingPrice({ price: price, executableAt: uint64(block.timestamp) + uint64(PRICE_TIMELOCK) });
            emit AssetPriceSubmitted(asset, price, uint64(block.timestamp) + uint64(PRICE_TIMELOCK));
        }
    }

    /// @notice Executes a scheduled price update (permissionless post-timelock).
    ///         Enforces the deviation bound against the live price.
    function executeAssetPrice(address asset) external {
        PendingPrice memory p = pendingPrices[asset];
        if (p.price == 0) revert NothingPending(asset);
        if (block.timestamp < p.executableAt) revert TimelockActive(p.executableAt);
        uint256 old = _prices[asset];
        if (old != 0) {
            uint256 diff = p.price > old ? p.price - old : old - p.price;
            if (diff * BPS > old * MAX_DEVIATION_BPS) revert DeviationTooLarge(old, p.price);
        }
        delete pendingPrices[asset];
        _prices[asset] = p.price;
        _updatedAt[asset] = block.timestamp;
        emit AssetPriceUpdated(asset, p.price);
    }

    function cancelAssetPrice(address asset) external onlyOwner {
        if (pendingPrices[asset].price == 0) revert NothingPending(asset);
        delete pendingPrices[asset];
        emit AssetPriceCancelled(asset);
    }

    function setAssetPrices(address[] calldata assets, uint256[] calldata prices) external onlyOwner {
        if (assets.length != prices.length) revert LengthMismatch();
        uint64 executableAt = uint64(block.timestamp) + uint64(PRICE_TIMELOCK);
        for (uint256 i; i < assets.length; ++i) {
            if (prices[i] == 0) revert InvalidPrice(prices[i]);
            if (_prices[assets[i]] == 0) {
                _prices[assets[i]] = prices[i];
                _updatedAt[assets[i]] = block.timestamp;
                emit AssetPriceUpdated(assets[i], prices[i]);
            } else {
                pendingPrices[assets[i]] = PendingPrice({ price: prices[i], executableAt: executableAt });
                emit AssetPriceSubmitted(assets[i], prices[i], executableAt);
            }
        }
    }

    /// @notice Executes all scheduled prices in a batch (permissionless post-timelock).
    function executeAssetPrices(address[] calldata assets) external {
        for (uint256 i; i < assets.length; ++i) {
            PendingPrice memory p = pendingPrices[assets[i]];
            if (p.price == 0) revert NothingPending(assets[i]);
            if (block.timestamp < p.executableAt) revert TimelockActive(p.executableAt);
            uint256 old = _prices[assets[i]];
            if (old != 0) {
                uint256 diff = p.price > old ? p.price - old : old - p.price;
                if (diff * BPS > old * MAX_DEVIATION_BPS) revert DeviationTooLarge(old, p.price);
            }
            delete pendingPrices[assets[i]];
            _prices[assets[i]] = p.price;
            _updatedAt[assets[i]] = block.timestamp;
            emit AssetPriceUpdated(assets[i], p.price);
        }
    }

    function getAssetPrice(address asset) external view returns (uint256) {
        uint256 price = _prices[asset];
        if (price == 0) revert PriceNotSet(asset);
        return price;
    }

    function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory) {
        uint256[] memory prices = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            uint256 price = _prices[assets[i]];
            if (price == 0) revert PriceNotSet(assets[i]);
            prices[i] = price;
        }
        return prices;
    }
}
