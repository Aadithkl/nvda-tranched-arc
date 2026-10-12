// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IHookSharePipe {
    function wrapQuote(uint256 quoteAmount, address receiver) external returns (uint256 shares);

    function unwrapQuote(uint256 shares, address receiver) external returns (uint256 quoteAmount);

    function unwrapQuote(uint256 shares, address receiver, uint256 minQuoteOut) external returns (uint256 quoteAmount);

    function unwrapEquity(uint256 shares, address receiver, uint256 minEquityOut)
        external
        returns (uint256 equityAmount);

    function unwrapProportional(uint256 shares, address receiver, uint256 minQuoteOut, uint256 minEquityOut)
        external
        returns (uint256 quoteAmount, uint256 equityAmount);
}
