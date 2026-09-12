// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface INVDAPriceOracle {
    struct PriceData {
        int192 mid;
        int192 bid;
        int192 ask;
        uint32 marketStatus;
        uint8 session;
        uint32 sourceTimestamp;
        uint256 updatedAt;
        bytes32 paymentRef;
        bool valid;
    }

    function getPrice() external view returns (PriceData memory data);

    function decimals() external view returns (uint8);
}
