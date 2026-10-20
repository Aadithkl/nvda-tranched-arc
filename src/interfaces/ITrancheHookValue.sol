// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ITrancheHookValue {
    function convertToQuote(uint256 shares) external view returns (uint256);

    function expired() external view returns (bool);

    function oracleValid() external view returns (bool);

    function spotDeviationBps() external view returns (bool ok, uint256 deviationBps);

    function maxUnwrapDeviationBps() external view returns (uint16);
}
