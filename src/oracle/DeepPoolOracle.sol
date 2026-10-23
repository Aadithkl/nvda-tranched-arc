// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { TickMath } from "v4-core/src/libraries/TickMath.sol";

/// @notice Minimal Uniswap v3 pool surface. v3 pools carry the built-in price oracle
///         (`observe`) that v4 removed, so the deep external pool is the on-chain TWAP
///         source instead of a hand-rolled accumulator.
interface IUniswapV3PoolLike {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
}

/// @notice The deep-pool price surface the vault consumes for the depeg check.
interface IDeepPoolOracle {
    /// @param secondsAgo TWAP window in seconds.
    /// @return ok false when the read is unavailable (thin pool, observe revert, bad tick).
    /// @return price1e18 quote (USD) per equity unit, 1e18-scaled.
    function consult(uint32 secondsAgo) external view returns (bool ok, uint256 price1e18);
}

/// @notice Time-weighted price of the EQUITY asset on its deepest on-chain venue.
///
///         The depeg check compares this against the stock-market reference (Chainlink).
///         Our own v4 book is deliberately NOT an input: a small pool is cheap to move, so
///         using it as the checked side re-introduces griefing no matter how good the
///         reference is. This oracle reads a deep, independent pool instead.
///
///         `consult` returns ok=false rather than a stale/unsafe price whenever the pool is
///         below `minLiquidity`, the window predates the oldest observation, or the mean
///         tick is out of bounds. Callers must treat ok=false as "no opinion", never as
///         "pegged".
contract DeepPoolOracle is IDeepPoolOracle, Ownable2Step {
    uint256 internal constant Q96 = 1 << 96;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    IUniswapV3PoolLike public immutable pool;
    address public immutable quote;
    address public immutable equity;
    uint8 public immutable quoteDecimals;
    uint8 public immutable equityDecimals;
    bool public immutable quoteIsToken0;

    /// @notice Minimum in-range pool liquidity (native L units) for the TWAP to be trusted.
    uint128 public minLiquidity;
    bool public enabled = true;

    event MinLiquidityUpdated(uint128 minLiquidity);
    event EnabledSet(bool enabled);

    error ZeroAddress();
    error InvalidWindow();

    constructor(address pool_, address quote_, address equity_, uint128 minLiquidity_) Ownable(msg.sender) {
        if (pool_ == address(0) || quote_ == address(0) || equity_ == address(0)) revert ZeroAddress();
        pool = IUniswapV3PoolLike(pool_);
        quote = quote_;
        equity = equity_;
        quoteDecimals = IERC20Metadata(quote_).decimals();
        equityDecimals = IERC20Metadata(equity_).decimals();
        quoteIsToken0 = pool.token0() == quote_;
        minLiquidity = minLiquidity_;
    }

    function setMinLiquidity(uint128 minLiquidity_) external onlyOwner {
        minLiquidity = minLiquidity_;
        emit MinLiquidityUpdated(minLiquidity_);
    }

    function setEnabled(bool enabled_) external onlyOwner {
        enabled = enabled_;
        emit EnabledSet(enabled_);
    }

    /// @inheritdoc IDeepPoolOracle
    function consult(uint32 secondsAgo) external view override returns (bool ok, uint256 price1e18) {
        if (!enabled || secondsAgo == 0) return (false, 0);
        if (pool.liquidity() < minLiquidity) return (false, 0);

        uint32[] memory agos = new uint32[](2);
        agos[0] = secondsAgo;
        agos[1] = 0;

        int56[] memory cum;
        try pool.observe(agos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            cum = tickCumulatives;
        } catch {
            return (false, 0);
        }
        if (cum.length != 2) return (false, 0);

        // Arithmetic mean tick over the window. int256 intermediates: cum values are int56.
        int256 delta = int256(cum[1]) - int256(cum[0]);
        int256 meanTick256 = delta / int256(uint256(secondsAgo));
        if (meanTick256 < MIN_TICK || meanTick256 > MAX_TICK) return (false, 0);

        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(int24(meanTick256));
        price1e18 = _poolPrice1e18(sqrtPriceX96);
        ok = price1e18 != 0;
    }

    /// @dev Same math as `PoolGuardHook._poolPrice1e18`: sqrtPriceX96 -> quote per equity,
    ///      1e18-scaled, for a 6-dec quote / 18-dec equity pair (and its inverse ordering).
    function _poolPrice1e18(uint160 sqrtPriceX96) internal view returns (uint256) {
        uint256 ratioX96 = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96);
        if (ratioX96 == 0) return 0;
        uint256 scaledEquity = 1e18 * (10 ** equityDecimals);
        uint256 scaledQuote = 10 ** quoteDecimals;
        if (quoteIsToken0) {
            // token1 is equity: price = scaledEquity / (ratio * scaledQuote)
            return Math.mulDiv(scaledEquity, Q96, Math.mulDiv(ratioX96, scaledQuote, 1));
        }
        // token0 is equity: price = ratio * scaledEquity / scaledQuote
        return Math.mulDiv(ratioX96, scaledEquity, Q96 * scaledQuote);
    }
}
