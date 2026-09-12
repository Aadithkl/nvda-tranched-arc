// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract NVDAPriceOracle {
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
        Session session;
        uint32 sourceTimestamp;
        uint256 updatedAt;
        bytes32 paymentRef;
        bool valid;
    }

    uint8 public immutable decimals;
    address public owner;
    address public pendingOwner;
    bool public paused;
    uint32 public maxStaleness;
    uint32 public marketStatus;

    mapping(address => bool) public writers;

    int192 internal _mid;
    uint32 internal _sourceTimestamp;
    bytes32 internal _paymentRef;
    uint256 internal _updatedAt;

    event OwnerUpdated(address indexed owner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event PausedSet(bool paused);
    event WriterUpdated(address indexed writer, bool allowed);
    event MaxStalenessUpdated(uint32 maxStaleness);
    event MarketStatusUpdated(uint32 marketStatus);
    event PriceUpdated(
        address indexed writer,
        int192 mid,
        uint32 marketStatus,
        uint32 sourceTimestamp,
        bytes32 paymentRef,
        uint256 updatedAt
    );

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error ZeroAddress();
    error NotWriter(address caller);
    error IsPaused();
    error InvalidMarketStatus(uint32 marketStatus);
    error InvalidPrice(int192 mid);
    error NoPriceData();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyWriter() {
        if (!writers[msg.sender]) revert NotWriter(msg.sender);
        _;
    }

    constructor(uint8 decimals_, address owner_) {
        decimals = decimals_;
        owner = owner_ == address(0) ? msg.sender : owner_;
        emit OwnerUpdated(owner);
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        writers[writer] = allowed;
        emit WriterUpdated(writer, allowed);
    }

    function setMaxStaleness(uint32 maxStaleness_) external onlyOwner {
        maxStaleness = maxStaleness_;
        emit MaxStalenessUpdated(maxStaleness_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
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

    function updatePrice(int192 mid, uint32 marketStatus_, uint32 sourceTimestamp, bytes32 paymentRef)
        external
        onlyWriter
    {
        if (paused) revert IsPaused();
        if (mid <= 0) revert InvalidPrice(mid);
        if (marketStatus_ > 5) revert InvalidMarketStatus(marketStatus_);

        _mid = mid;
        _sourceTimestamp = sourceTimestamp;
        _paymentRef = paymentRef;
        _updatedAt = block.timestamp;

        marketStatus = marketStatus_;
        emit MarketStatusUpdated(marketStatus_);
        emit PriceUpdated(msg.sender, mid, marketStatus_, sourceTimestamp, paymentRef, block.timestamp);
    }

    function sessionFor(uint32 status) public pure returns (Session) {
        if (status == 1 || status == 3) return Session.Extended;
        if (status == 2) return Session.Regular;
        if (status == 4) return Session.Overnight;
        return Session.None;
    }

    function getPrice() external view returns (PriceData memory data) {
        uint32 status = marketStatus;
        Session session = sessionFor(status);

        data.mid = _mid;
        data.bid = _mid;
        data.ask = _mid;
        data.marketStatus = status;
        data.session = session;
        data.sourceTimestamp = _sourceTimestamp;
        data.updatedAt = _updatedAt;
        data.paymentRef = _paymentRef;
        data.valid =
            _mid > 0 && session != Session.None && _updatedAt != 0 && block.timestamp - _updatedAt <= maxStaleness;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (_updatedAt == 0) revert NoPriceData();
        return (uint80(_sourceTimestamp), int256(_mid), uint256(_sourceTimestamp), _updatedAt, uint80(_sourceTimestamp));
    }

    function description() external pure returns (string memory) {
        return "NVDA/USD (x402 push)";
    }
}
