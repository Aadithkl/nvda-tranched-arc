// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IDeepPoolOracle } from "../oracle/DeepPoolOracle.sol";

/// @notice Test double for the deep-pool TWAP: lets tests pin the price or mark the read
///         unavailable, without standing up a real Uniswap v3 pool with observations.
contract MockDeepOracle is IDeepPoolOracle {
    bool public okFlag = true;
    uint256 public price1e18;

    function setOk(bool ok_) external {
        okFlag = ok_;
    }

    function setPrice(uint256 price_) external {
        price1e18 = price_;
    }

    function consult(uint32) external view returns (bool, uint256) {
        return (okFlag, price1e18);
    }
}
