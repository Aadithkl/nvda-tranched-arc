// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library WadRayMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant HALF_WAD = 0.5e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant HALF_RAY = 0.5e27;
    uint256 internal constant WAD_RAY_RATIO = 1e9;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    function rayMul(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / RAY;
    }

    function rayDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * RAY) / b;
    }

    function wadMul(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b + HALF_WAD) / WAD;
    }

    function wadToRay(uint256 a) internal pure returns (uint256) {
        return a * WAD_RAY_RATIO;
    }

    function calculateLinearInterest(uint256 rate, uint256 elapsed) internal pure returns (uint256) {
        return (rate * elapsed) / SECONDS_PER_YEAR + RAY;
    }
}
