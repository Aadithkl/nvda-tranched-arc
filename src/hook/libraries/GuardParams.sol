// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Guard configuration for `PoolGuardHook`: the dials the vault (owner) tunes — often, to
///         keep the guard band centered on the price — plus the IL-guard economics.
library GuardParams {
    struct Params {
        /// @notice Half-width of the guard band in ticks, centered on the current tick at every
        ///         (re)deploy. Rounded outward to `key.tickSpacing` at use time.
        int24 guardTickWidth;
        /// @notice Half-width of the base band in ticks, centered on the current tick at deploy.
        int24 baseTickWidth;
        /// @notice v4 liquidity (L) deployed for the guard band; the bulk of protocol liquidity.
        uint128 guardLiquidity;
        /// @notice v4 liquidity (L) deployed for the base band; the always-present discovery anchor.
        uint128 baseLiquidity;
        /// @notice Minimum oracle-edge of a swap (bps of our share of its notional) to keep or
        ///         redeploy the guard. Below this the guard is pulled.
        uint16 minEvBps;
        /// @notice Max |pool − oracle| deviation (bps) allowed when the periodic recheck redeploys.
        ///         Zero disables the band check.
        uint16 recheckMaxDeviationBps;
        /// @notice Seconds a pulled guard stays out before the periodic recheck may re-arm it.
        uint32 recheckInterval;
        /// @notice Hook-level oracle freshness bound in seconds.
        uint32 maxPriceAge;
        /// @notice Bitmask of oracle sessions eligible for swaps; bit `i` set => session `i`
        ///         allowed. Zero disables the session check (oracle `valid` still applies).
        uint8 allowedSessionsMask;
    }

    uint16 internal constant MAX_BPS = 10_000;
    uint8 internal constant MAX_SESSION_BIT = 3;

    error InvalidGuardWidth(int24 width);
    error InvalidBaseWidth(int24 width);
    error InvalidLiquidity(uint128 liquidity);
    error InvalidMinEv(uint16 minEvBps);
    error InvalidRecheck(uint32 recheckInterval, uint16 recheckMaxDeviationBps);
    error InvalidMaxPriceAge(uint32 maxPriceAge);
    error InvalidSessionMask(uint8 mask);

    function validate(Params memory p) internal pure {
        if (p.guardTickWidth <= 0) revert InvalidGuardWidth(p.guardTickWidth);
        if (p.baseTickWidth <= 0) revert InvalidBaseWidth(p.baseTickWidth);
        if (p.guardLiquidity == 0) revert InvalidLiquidity(0);
        if (p.baseLiquidity == 0) revert InvalidLiquidity(0);
        if (p.minEvBps > MAX_BPS) revert InvalidMinEv(p.minEvBps);
        if (p.recheckInterval == 0) revert InvalidRecheck(p.recheckInterval, p.recheckMaxDeviationBps);
        if (p.recheckMaxDeviationBps > MAX_BPS) revert InvalidRecheck(p.recheckInterval, p.recheckMaxDeviationBps);
        if (p.maxPriceAge == 0) revert InvalidMaxPriceAge(p.maxPriceAge);
        if (p.allowedSessionsMask >> (MAX_SESSION_BIT + 1) != 0) revert InvalidSessionMask(p.allowedSessionsMask);
    }
}
