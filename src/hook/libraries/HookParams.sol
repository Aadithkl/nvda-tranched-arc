// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

library HookParams {
    uint24 internal constant MAX_FEE = 1_000_000;
    uint16 internal constant MAX_DEVIATION_BPS = 5_000;
    uint16 internal constant MAX_TOXICITY_MULTIPLIER_BPS = 10_000;

    struct Params {
        bool quotingEnabled;
        uint24 baseFee;
        uint16 maxDeviationBps;
        uint16 toxicityMultiplierBps;
        uint16 minEvBps;
        uint32 cooldownSeconds;
        uint32 ttl;
        uint32 gracePeriod;
        uint128 maxDeployPerSwap;
        int24 bucketTicks;
    }

    error InvalidBaseFee(uint24 baseFee);
    error InvalidDeviation(uint16 maxDeviationBps);
    error InvalidMultiplier(uint16 toxicityMultiplierBps);
    error InvalidTtl(uint32 ttl);
    error InvalidBucketTicks(int24 bucketTicks);

    function validate(Params memory p) internal pure {
        if (p.baseFee > MAX_FEE) revert InvalidBaseFee(p.baseFee);
        if (p.maxDeviationBps > MAX_DEVIATION_BPS) revert InvalidDeviation(p.maxDeviationBps);
        if (p.toxicityMultiplierBps > MAX_TOXICITY_MULTIPLIER_BPS) revert InvalidMultiplier(p.toxicityMultiplierBps);
        if (p.ttl == 0) revert InvalidTtl(p.ttl);
        if (p.bucketTicks <= 0) revert InvalidBucketTicks(p.bucketTicks);
    }
}
