// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

interface IChainlinkAggregator {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface ISessionStatus {
    function marketStatus() external view returns (uint32);
}

/// @notice Composite oracle for the Robinhood-chain book: the mid price comes from the stock
///         token's Chainlink feed (which already includes the ERC-8056 corporate-action
///         multiplier), while the trading session/status comes from the pushed session layer (the
///         keeper session pusher). Implements the hook's `INVDAPriceOracle` shape so the
///         market-open guard (`allowedSessionsMask`) and staleness checks keep working unchanged.
contract ChainlinkSessionOracle {
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
    IChainlinkAggregator public priceFeed;
    ISessionStatus public sessionSource;
    uint32 public maxPriceAge;
    uint8 public decimals;

    event OwnerUpdated(address indexed owner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event PriceFeedUpdated(address indexed feed);
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

    constructor(address priceFeed_, address sessionSource_, uint32 maxPriceAge_) {
        if (priceFeed_ == address(0) || sessionSource_ == address(0)) revert ZeroAddress();
        if (maxPriceAge_ == 0) revert InvalidFeed();
        uint8 feedDecimals = IChainlinkAggregator(priceFeed_).decimals();
        if (feedDecimals > 18) revert InvalidFeed();
        owner = msg.sender;
        priceFeed = IChainlinkAggregator(priceFeed_);
        sessionSource = ISessionStatus(sessionSource_);
        maxPriceAge = maxPriceAge_;
        decimals = feedDecimals;
        emit OwnerUpdated(owner);
        emit PriceFeedUpdated(priceFeed_);
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

    function setPriceFeed(address feed) external onlyOwner {
        if (feed == address(0)) revert ZeroAddress();
        uint8 feedDecimals = IChainlinkAggregator(feed).decimals();
        if (feedDecimals > 18) revert InvalidFeed();
        priceFeed = IChainlinkAggregator(feed);
        decimals = feedDecimals;
        emit PriceFeedUpdated(feed);
    }

    function setSessionSource(address source) external onlyOwner {
        if (source == address(0)) revert ZeroAddress();
        sessionSource = ISessionStatus(source);
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
        (, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
        uint32 status = sessionSource.marketStatus();
        Session session = sessionFor(status);

        int192 mid;
        if (answer > 0 && answer <= type(int192).max) mid = int192(answer);

        data.mid = mid;
        data.bid = mid;
        data.ask = mid;
        data.marketStatus = status;
        data.session = uint8(session);
        data.sourceTimestamp = uint32(updatedAt);
        data.updatedAt = updatedAt;
        data.paymentRef = bytes32(0);
        data.valid = mid > 0 && updatedAt != 0 && block.timestamp - updatedAt <= maxPriceAge && session != Session.None;
    }
}

