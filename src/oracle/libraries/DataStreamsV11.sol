// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library DataStreamsV11 {
    struct Report {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 mid;
        uint64 lastSeenTimestampNs;
        int192 bid;
        int192 bidVolume;
        int192 ask;
        int192 askVolume;
        int192 lastTradedPrice;
        uint32 marketStatus;
    }

    uint32 internal constant STATUS_UNKNOWN = 0;
    uint32 internal constant STATUS_PRE_MARKET = 1;
    uint32 internal constant STATUS_REGULAR = 2;
    uint32 internal constant STATUS_POST_MARKET = 3;
    uint32 internal constant STATUS_OVERNIGHT = 4;
    uint32 internal constant STATUS_CLOSED = 5;

    function decode(bytes memory verified) internal pure returns (Report memory) {
        return abi.decode(verified, (Report));
    }
}
