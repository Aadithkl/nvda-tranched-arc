// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IPriceOracleGetter } from "./interfaces/IPriceOracleGetter.sol";

contract PeggedPriceOracle is Ownable2Step, IPriceOracleGetter {
    uint256 public constant BASE_CURRENCY_UNIT = 1e8;
    bytes32 public constant BASE_CURRENCY = "USD";

    mapping(address => uint256) private _prices;

    event AssetPriceUpdated(address indexed asset, uint256 price);

    error PriceNotSet(address asset);
    error InvalidPrice(uint256 price);
    error LengthMismatch();

    constructor(address owner_) Ownable(owner_) { }

    function setAssetPrice(address asset, uint256 price) external onlyOwner {
        if (price == 0) revert InvalidPrice(price);
        _prices[asset] = price;
        emit AssetPriceUpdated(asset, price);
    }

    function setAssetPrices(address[] calldata assets, uint256[] calldata prices) external onlyOwner {
        if (assets.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < assets.length; ++i) {
            if (prices[i] == 0) revert InvalidPrice(prices[i]);
            _prices[assets[i]] = prices[i];
            emit AssetPriceUpdated(assets[i], prices[i]);
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
