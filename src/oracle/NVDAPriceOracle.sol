// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IVerifierProxy} from "./interfaces/IVerifierProxy.sol";
import {DataStreamsV11} from "./libraries/DataStreamsV11.sol";

contract NVDAPriceOracle {
    enum Session {
        None,
        Regular,
        Extended,
        Overnight
    }

    enum Source {
        None,
        ChainlinkStreams,
        X402
    }

    struct FeedConfig {
        Session session;
        uint32 maxStaleness;
        bool enabled;
    }

    struct StoredPrice {
        int192 mid;
        int192 bid;
        int192 ask;
        uint32 observationsTimestamp;
        uint64 lastSeenTimestampNs;
        uint32 marketStatus;
        uint256 updatedAt;
    }

    struct X402Point {
        int192 mid;
        uint32 marketStatus;
        uint32 sourceTimestamp;
        bytes32 paymentRef;
        uint256 updatedAt;
    }

    struct PriceData {
        int192 mid;
        int192 bid;
        int192 ask;
        uint32 observationsTimestamp;
        uint32 marketStatus;
        Session session;
        Source source;
        uint256 updatedAt;
        bool valid;
    }

    IVerifierProxy public immutable verifier;
    uint8 public immutable decimals;
    address public owner;
    bool public paused;

    uint32 public marketStatus;
    Source public primarySource;
    uint32 public x402MaxStaleness;

    mapping(address => bool) public writers;
    mapping(bytes32 => FeedConfig) public feedConfig;
    mapping(Session => FeedConfig) public sessionConfig;
    bytes32[] public feedIds;

    mapping(Session => StoredPrice) internal _prices;
    X402Point internal _x402;

    event OwnerUpdated(address indexed owner);
    event PausedSet(bool paused);
    event FeedConfigured(bytes32 indexed feedId, Session session, uint32 maxStaleness);
    event MarketStatusUpdated(uint32 marketStatus);
    event WriterUpdated(address indexed writer, bool allowed);
    event PrimarySourceUpdated(Source source);
    event X402MaxStalenessUpdated(uint32 maxStaleness);
    event PriceUpdated(
        bytes32 indexed feedId,
        Session session,
        int192 mid,
        int192 bid,
        int192 ask,
        uint32 marketStatus,
        uint32 observationsTimestamp,
        uint256 updatedAt
    );
    event X402PriceUpdated(
        address indexed writer,
        int192 mid,
        uint32 marketStatus,
        uint32 sourceTimestamp,
        bytes32 paymentRef,
        uint256 updatedAt
    );

    error NotOwner(address caller);
    error NotWriter(address caller);
    error IsPaused();
    error InvalidSession();
    error InvalidSource();
    error InvalidMarketStatus(uint32 marketStatus);
    error UnknownFeed(bytes32 feedId);
    error SessionMismatch(Session expected, uint32 marketStatus);
    error InvalidPrice(int192 mid);
    error NoPriceData(Session session);
    error FeeManagerNotSupported(address feeManager);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyWriter() {
        if (!writers[msg.sender]) revert NotWriter(msg.sender);
        _;
    }

    constructor(address verifier_, uint8 decimals_, address owner_) {
        verifier = IVerifierProxy(verifier_);
        decimals = decimals_;
        owner = owner_ == address(0) ? msg.sender : owner_;
        primarySource = Source.ChainlinkStreams;
        emit OwnerUpdated(owner);
    }

    function configureFeed(bytes32 feedId, Session session, uint32 maxStaleness) external onlyOwner {
        if (session == Session.None) revert InvalidSession();
        if (!feedConfig[feedId].enabled) {
            feedIds.push(feedId);
        }
        feedConfig[feedId] = FeedConfig({session: session, maxStaleness: maxStaleness, enabled: true});
        sessionConfig[session] = FeedConfig({session: session, maxStaleness: maxStaleness, enabled: true});
        emit FeedConfigured(feedId, session, maxStaleness);
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        writers[writer] = allowed;
        emit WriterUpdated(writer, allowed);
    }

    function setPrimarySource(Source source) external onlyOwner {
        if (source == Source.None) revert InvalidSource();
        primarySource = source;
        emit PrimarySourceUpdated(source);
    }

    function setX402MaxStaleness(uint32 maxStaleness) external onlyOwner {
        x402MaxStaleness = maxStaleness;
        emit X402MaxStalenessUpdated(maxStaleness);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    function verifyAndUpdate(bytes calldata unverifiedReport)
        external
        returns (DataStreamsV11.Report memory report)
    {
        if (paused) revert IsPaused();
        address feeManager = verifier.s_feeManager();
        if (feeManager != address(0)) revert FeeManagerNotSupported(feeManager);

        bytes memory verified = verifier.verify(unverifiedReport, "");
        report = DataStreamsV11.decode(verified);

        FeedConfig memory cfg = feedConfig[report.feedId];
        if (!cfg.enabled) revert UnknownFeed(report.feedId);

        marketStatus = report.marketStatus;
        emit MarketStatusUpdated(report.marketStatus);

        if (
            report.marketStatus == DataStreamsV11.STATUS_CLOSED
                || report.marketStatus == DataStreamsV11.STATUS_UNKNOWN
        ) {
            return report;
        }

        Session session = sessionFor(report.marketStatus);
        if (session != cfg.session) revert SessionMismatch(cfg.session, report.marketStatus);
        if (report.mid <= 0) revert InvalidPrice(report.mid);

        _prices[session] = StoredPrice({
            mid: report.mid,
            bid: report.bid,
            ask: report.ask,
            observationsTimestamp: report.observationsTimestamp,
            lastSeenTimestampNs: report.lastSeenTimestampNs,
            marketStatus: report.marketStatus,
            updatedAt: block.timestamp
        });

        emit PriceUpdated(
            report.feedId,
            session,
            report.mid,
            report.bid,
            report.ask,
            report.marketStatus,
            report.observationsTimestamp,
            block.timestamp
        );
    }

    function updateX402Price(int192 mid, uint32 marketStatus_, uint32 sourceTimestamp, bytes32 paymentRef)
        external
        onlyWriter
    {
        if (paused) revert IsPaused();
        if (mid <= 0) revert InvalidPrice(mid);
        if (marketStatus_ > DataStreamsV11.STATUS_CLOSED) revert InvalidMarketStatus(marketStatus_);

        _x402 = X402Point({
            mid: mid,
            marketStatus: marketStatus_,
            sourceTimestamp: sourceTimestamp,
            paymentRef: paymentRef,
            updatedAt: block.timestamp
        });

        marketStatus = marketStatus_;
        emit MarketStatusUpdated(marketStatus_);
        emit X402PriceUpdated(msg.sender, mid, marketStatus_, sourceTimestamp, paymentRef, block.timestamp);
    }

    function sessionFor(uint32 status) public pure returns (Session) {
        if (status == DataStreamsV11.STATUS_PRE_MARKET || status == DataStreamsV11.STATUS_POST_MARKET) {
            return Session.Extended;
        }
        if (status == DataStreamsV11.STATUS_REGULAR) return Session.Regular;
        if (status == DataStreamsV11.STATUS_OVERNIGHT) return Session.Overnight;
        return Session.None;
    }

    function getPrice() external view returns (PriceData memory) {
        return _resolve();
    }

    function getPriceFrom(Source source) external view returns (PriceData memory) {
        return _priceFrom(source);
    }

    function _resolve() internal view returns (PriceData memory) {
        PriceData memory primary = _priceFrom(primarySource);
        if (primary.valid) return primary;

        Source fallbackSource = primarySource == Source.X402 ? Source.ChainlinkStreams : Source.X402;
        PriceData memory secondary = _priceFrom(fallbackSource);
        if (secondary.valid) return secondary;

        return primary;
    }

    function _priceFrom(Source source) internal view returns (PriceData memory data) {
        data.source = source;
        if (source == Source.ChainlinkStreams) return _chainlinkPrice(data);
        if (source == Source.X402) return _x402Price(data);
        return data;
    }

    function _chainlinkPrice(PriceData memory data) internal view returns (PriceData memory) {
        Session session = sessionFor(marketStatus);
        data.session = session;
        data.marketStatus = marketStatus;
        if (session == Session.None) return data;

        StoredPrice memory stored = _prices[session];
        if (stored.observationsTimestamp == 0) return data;

        FeedConfig memory cfg = sessionConfig[session];
        data.mid = stored.mid;
        data.bid = stored.bid;
        data.ask = stored.ask;
        data.observationsTimestamp = stored.observationsTimestamp;
        data.updatedAt = stored.updatedAt;
        data.valid = stored.mid > 0 && block.timestamp - stored.updatedAt <= cfg.maxStaleness;
        return data;
    }

    function _x402Price(PriceData memory data) internal view returns (PriceData memory) {
        X402Point memory point = _x402;
        if (point.updatedAt == 0) return data;

        data.mid = point.mid;
        data.bid = point.mid;
        data.ask = point.mid;
        data.marketStatus = point.marketStatus;
        data.session = sessionFor(point.marketStatus);
        data.observationsTimestamp = point.sourceTimestamp;
        data.updatedAt = point.updatedAt;
        data.valid = point.mid > 0 && data.session != Session.None
            && block.timestamp - point.updatedAt <= x402MaxStaleness;
        return data;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        PriceData memory data = _resolve();
        if (data.mid == 0 || data.updatedAt == 0) revert NoPriceData(data.session);
        return (
            uint80(data.observationsTimestamp),
            int256(data.mid),
            uint256(data.observationsTimestamp),
            data.updatedAt,
            uint80(data.observationsTimestamp)
        );
    }

    function description() external pure returns (string memory) {
        return "NVDA/USD (Chainlink Data Streams | x402 push)";
    }

    function feedCount() external view returns (uint256) {
        return feedIds.length;
    }

    function x402Point() external view returns (X402Point memory) {
        return _x402;
    }
}
