// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Settable Chainlink-style feed for oracle tests.
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer_, uint256 startedAt, uint256 updatedAt_, uint80 answeredInRound)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @notice Settable session/status source for the composite oracle tests.
contract MockSessionStatus {
    uint32 public marketStatus;

    constructor(uint32 status_) {
        marketStatus = status_;
    }

    function setMarketStatus(uint32 status_) external {
        marketStatus = status_;
    }
}

/// @notice Morpho oracle stub: constant 1e36-scaled collateral price.
contract MockMorphoOracle {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }
}

/// @notice Minimal vault stand-in for StrategyModule unit tests (holds funds, approves module).
contract MockVaultBase {
    uint256 public baseAssets;

    constructor(address asset, address module) {
        baseAssets = 0;
        (bool ok,) = asset.call(abi.encodeWithSignature("approve(address,uint256)", module, type(uint256).max));
        require(ok, "approve");
    }

    function setBaseAssets(uint256 value) external {
        baseAssets = value;
    }

    function baseManagedAssets() external view returns (uint256) {
        return baseAssets;
    }

    function expired() external pure returns (bool) {
        return false;
    }
}
