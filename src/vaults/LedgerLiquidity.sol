// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBookHook } from "../interfaces/IBookHook.sol";
import { IStrategyModule } from "../adapters/IStrategyModule.sol";

interface IVenuePoolLike {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/// @notice Liquidity ladder for `LedgerVault`, extracted as a delegatecall library so the
///         vault stays inside EIP-170 (same pattern as `LedgerSettlement`).
///
///         Runs IN the vault's context via delegatecall: `address(this)` is the vault, so
///         hook calls (vault is hook owner) and token balance reads resolve correctly.
///         Touches no vault storage — every dependency is an explicit parameter.
library LedgerLiquidity {
    error InsufficientQuote(uint256 requested, uint256 available);
    error InsufficientEquity(uint256 requested, uint256 available);
    error VenueUnset();

    event GuardRecalledForWithdrawal(uint256 shortfall);
    event Withdrawn(uint256 amount);

    /// @notice Gather `amount + reserved` quote through the ladder:
    ///         idle -> hook inventory -> venue -> strategy module -> guard recall.
    function ensureQuote(
        IERC20 quote,
        IBookHook hook,
        address venue,
        address strategyModule,
        bool guardRecallOnWithdraw,
        uint256 amount,
        uint256 reserved
    ) public {
        uint256 needed = amount + reserved;
        uint256 balance = quote.balanceOf(address(this));
        if (balance >= needed) return;

        uint256 shortfall = needed - balance;
        uint256 hookIdle = hook.quoteIdle();
        uint256 fromHook = shortfall < hookIdle ? shortfall : hookIdle;
        if (fromHook != 0) hook.withdrawInventory(fromHook, 0);

        balance = quote.balanceOf(address(this));
        if (balance < needed && venue != address(0)) {
            withdrawFromVenue(IVenuePoolLike(venue), quote, needed - balance);
            balance = quote.balanceOf(address(this));
        }
        if (balance < needed && strategyModule != address(0)) {
            IStrategyModule(strategyModule).pullToVault(needed - balance);
            balance = quote.balanceOf(address(this));
        }
        if (balance < needed && guardRecallOnWithdraw && hook.poolInitialized()) {
            hook.recallToVault();
            emit GuardRecalledForWithdrawal(needed - balance);
            balance = quote.balanceOf(address(this));
        }
        if (balance < needed) revert InsufficientQuote(needed, balance);
    }

    /// @notice Gather `amount` equity through idle -> hook inventory -> guard recall.
    function ensureEquity(IERC20 equity, IBookHook hook, bool guardRecallOnWithdraw, uint256 amount) public {
        uint256 balance = equity.balanceOf(address(this));
        if (balance >= amount) return;

        uint256 shortfall = amount - balance;
        uint256 hookIdle = hook.equityIdle();
        uint256 fromHook = shortfall < hookIdle ? shortfall : hookIdle;
        if (fromHook != 0) hook.withdrawInventory(0, fromHook);

        balance = equity.balanceOf(address(this));
        if (balance < amount && guardRecallOnWithdraw && hook.poolInitialized()) {
            hook.recallToVault();
            emit GuardRecalledForWithdrawal(amount - balance);
            balance = equity.balanceOf(address(this));
        }
        if (balance < amount) revert InsufficientEquity(amount, balance);
    }

    /// @notice Venue withdrawal, fail closed on a short payout.
    function withdrawFromVenue(IVenuePoolLike venue, IERC20 quote, uint256 amount)
        public
        returns (uint256 withdrawn)
    {
        if (address(venue) == address(0)) revert VenueUnset();
        withdrawn = venue.withdraw(address(quote), amount, address(this));
        if (withdrawn < amount) revert InsufficientQuote(amount, withdrawn);
        emit Withdrawn(withdrawn);
    }
}
