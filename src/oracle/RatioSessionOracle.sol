// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

interface IRatioChainlinkAggregator {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IRatioSessionStatus {
    function marketStatus() external view returns (uint32);
}

/// @notice Composite oracle for the WETH-quote book: mid = WETH per NVDA = NVDA/USD ÷ ETH/USD,
///         scaled to 18 decimals (the hook expects the equity price in quote at 1e18). Both legs
///         are Chainlink feeds (8 dec on Robinhood Chain; prices already include the ERC-8056
///         corporate-action multiplier — never re-applied here). The session/status gate follows
///         the EQUITY leg (24/5 stocks): whenever the equity market is closed the quote reads
///         invalid, exactly like the USDG book. Fail-closed on any stale/invalid leg or a
///         non-positive denominator. Implements the hook's `INVDAPriceOracle` shape.
///         Verified live legs: NVDA/USD 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15,
///         ETH/USD 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9 (see deployments/robinhood-mainnet.json).
contract RatioSessionOracle {
    enum Session {
        None,
        Regular,
        Extended,
        Overnight
    }

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

    address public owner;
    address public pendingOwner;
    IRatioChainlinkAggregator public nvdaFeed;
    IRatioChainlinkAggregator public ethFeed;
    IRatioSessionStatus public sessionSource;
    uint32 public maxPriceAge;
    uint8 public nvdaDecimals;
    uint8 public ethDecimals;
    uint8 public constant decimals = 18;

    event OwnerUpdated(address indexed owner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event NvdaFeedUpdated(address indexed feed);
    event EthFeedUpdated(address indexed feed);
    event SessionSourceUpdated(address indexed source);
    event MaxPriceAgeUpdated(uint32 maxPriceAge);

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error ZeroAddress();
    error InvalidFeed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor(address nvdaFeed_, address ethFeed_, address sessionSource_, uint32 maxPriceAge_) {
        if (nvdaFeed_ == address(0) || ethFeed_ == address(0) || sessionSource_ == address(0)) revert ZeroAddress();
        if (maxPriceAge_ == 0) revert InvalidFeed();
        uint8 nvdaDec = IRatioChainlinkAggregator(nvdaFeed_).decimals();
        uint8 ethDec = IRatioChainlinkAggregator(ethFeed_).decimals();
        if (nvdaDec > 18 || ethDec > 18) revert InvalidFeed();
        owner = msg.sender;
        nvdaFeed = IRatioChainlinkAggregator(nvdaFeed_);
        ethFeed = IRatioChainlinkAggregator(ethFeed_);
        sessionSource = IRatioSessionStatus(sessionSource_);
        maxPriceAge = maxPriceAge_;
        nvdaDecimals = nvdaDec;
        ethDecimals = ethDec;
        emit OwnerUpdated(owner);
        emit NvdaFeedUpdated(nvdaFeed_);
        emit EthFeedUpdated(ethFeed_);
        emit SessionSourceUpdated(sessionSource_);
        emit MaxPriceAgeUpdated(maxPriceAge_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        pendingOwner = address(0);
        owner = msg.sender;
        emit OwnerUpdated(msg.sender);
    }

    function setNvdaFeed(address feed) external onlyOwner {
        if (feed == address(0)) revert ZeroAddress();
        uint8 feedDecimals = IRatioChainlinkAggregator(feed).decimals();
        if (feedDecimals > 18) revert InvalidFeed();
        nvdaFeed = IRatioChainlinkAggregator(feed);
        nvdaDecimals = feedDecimals;
        emit NvdaFeedUpdated(feed);
    }

    function setEthFeed(address feed) external onlyOwner {
        if (feed == address(0)) revert ZeroAddress();
        uint8 feedDecimals = IRatioChainlinkAggregator(feed).decimals();
        if (feedDecimals > 18) revert InvalidFeed();
        ethFeed = IRatioChainlinkAggregator(feed);
        ethDecimals = feedDecimals;
        emit EthFeedUpdated(feed);
    }

    function setSessionSource(address source) external onlyOwner {
        if (source == address(0)) revert ZeroAddress();
        sessionSource = IRatioSessionStatus(source);
        emit SessionSourceUpdated(source);
    }

    function setMaxPriceAge(uint32 maxPriceAge_) external onlyOwner {
        if (maxPriceAge_ == 0) revert InvalidFeed();
        maxPriceAge = maxPriceAge_;
        emit MaxPriceAgeUpdated(maxPriceAge_);
    }

    function sessionFor(uint32 status) public pure returns (Session) {
        if (status == 1 || status == 3) return Session.Extended;
        if (status == 2) return Session.Regular;
        if (status == 4) return Session.Overnight;
        return Session.None;
    }

    function getPrice() external view returns (PriceData memory data) {
        (, int256 nvdaAnswer,, uint256 nvdaUpdatedAt,) = nvdaFeed.latestRoundData();
        (, int256 ethAnswer,, uint256 ethUpdatedAt,) = ethFeed.latestRoundData();
        uint32 status = sessionSource.marketStatus();
        Session session = sessionFor(status);

        uint256 updatedAt = nvdaUpdatedAt < ethUpdatedAt ? nvdaUpdatedAt : ethUpdatedAt;
        int192 mid;
        // Either leg dated in the future must fail closed, not underflow-revert.
        bool nvdaFresh =
            nvdaUpdatedAt != 0 && nvdaUpdatedAt <= block.timestamp && block.timestamp - nvdaUpdatedAt <= maxPriceAge;
        bool ethFresh =
            ethUpdatedAt != 0 && ethUpdatedAt <= block.timestamp && block.timestamp - ethUpdatedAt <= maxPriceAge;
        if (nvdaAnswer > 0 && ethAnswer > 0 && nvdaFresh && ethFresh) {
            uint256 nvdaUsd18 = uint256(nvdaAnswer) * 10 ** (18 - nvdaDecimals);
            uint256 ethUsd18 = uint256(ethAnswer) * 10 ** (18 - ethDecimals);
            if (ethUsd18 != 0) {
                uint256 ratio = nvdaUsd18 * 1e18 / ethUsd18;
                if (ratio <= uint256(uint192(type(int192).max))) mid = int192(uint192(ratio));
            }
        }

        data.mid = mid;
        data.bid = mid;
        data.ask = mid;
        data.marketStatus = status;
        data.session = uint8(session);
        data.sourceTimestamp = uint32(updatedAt);
        data.updatedAt = updatedAt;
        data.paymentRef = bytes32(0);
        data.valid = mid > 0 && session != Session.None;
    }
}
