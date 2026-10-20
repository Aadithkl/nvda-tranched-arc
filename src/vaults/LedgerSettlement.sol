// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IBookHook } from "../interfaces/IBookHook.sol";
import { ITrancheAccountant } from "../interfaces/ITrancheAccountant.sol";
import { IStrategyModule } from "../adapters/IStrategyModule.sol";
import { HookShareToken } from "../core/HookShareToken.sol";

interface ILedgerVenuePool {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ILedgerMaturedVault {
    function creditSettlement(uint256 quoteAmount, uint256 equityAmount) external;
}

/// @notice One-shot settlement engine for `LedgerVault`, extracted as a delegatecall
///         library so the vault stays inside EIP-170 (it sat at 24,244/24,576 before
///         the split). Invoked exactly once per book, after expiry:
///         pulls the book out of the hook, unwinds every strategy adapter and the
///         lending venue, then hands the senior guarantee first, remaining QUOTE plus
///         all equity to junior, and freezes each tranche's terminal rates.
///
///         Authority: runs via delegatecall IN the vault, so `address(this)` and
///         `msg.sender`-gated downstream calls (hook owner, share-token hook,
///         tranche pipes) all still resolve to the vault. Uses no `msg.sender` of
///         its own — every recipient is an explicit parameter. The vault checks
///         expiry, flips its `settled` flag FIRST (checks-effects), then delegates
///         here; its `nonReentrant` wrapper covers the whole call.
library LedgerSettlement {
    using SafeERC20 for IERC20;

    error AccountantUnset();
    error VaultsUnset();
    error SettlementNotReady();

    event SettlementFinalized(
        uint256 seniorShares, uint256 juniorShares, uint256 quoteToSenior, uint256 quoteToJunior, uint256 equityUnits
    );

    /// @param allowHaircut Owner escape hatch for a pathological book: settles with a
    ///        senior haircut when QUOTE cannot cover the guarantee.
    function finalize(
        IBookHook hook,
        address strategyModule,
        address venue,
        IERC20 aToken,
        HookShareToken shareToken,
        IERC20 quote,
        IERC20 equity,
        address accountant,
        bool allowHaircut
    ) public {
        if (accountant == address(0)) revert AccountantUnset();
        ITrancheAccountant accountant_ = ITrancheAccountant(accountant);
        address seniorVault = accountant_.seniorVault();
        address juniorVault = accountant_.juniorVault();
        if (seniorVault == address(0) || juniorVault == address(0)) revert VaultsUnset();

        hook.unwindClaims();
        if (!hook.exited()) hook.pullAll();

        // Withdraw the lending venue BEFORE repaying loop debt. `exitAll` funds loop
        // repayment from the vault's quote balance; if quote is parked in the venue,
        // doing strategy first reverts for insufficient vault funds and blocks settlement.
        if (venue != address(0)) {
            uint256 venueUnits = aToken.balanceOf(address(this));
            // Fail closed on short venue withdrawals — a shortfall must not silently
            // shrink the waterfall.
            if (venueUnits != 0) {
                uint256 got = ILedgerVenuePool(venue).withdraw(address(quote), venueUnits, address(this));
                if (got < venueUnits) revert SettlementNotReady();
            }
        }

        if (strategyModule != address(0)) {
            // Funding for the loop-debt pull lives here: `exitAll` repays loop debt
            // by pulling from the vault, and the vault carries NO standing allowance
            // (a standing approval would let a swapped module drain it). Approve the
            // exact upper bound (all loop debt), unwind, then reset to zero — no
            // residual allowance survives settlement either way, since a mid-flight
            // revert rolls the whole transaction back.
            uint256 loopNeed = IStrategyModule(strategyModule).totalLoopDebt();
            quote.forceApprove(strategyModule, loopNeed);
            IStrategyModule(strategyModule).exitAll();
            quote.forceApprove(strategyModule, 0);
        }

        uint256 hSenior = shareToken.balanceOf(seniorVault);
        uint256 hJunior = shareToken.balanceOf(juniorVault);

        uint256 quoteUnits = quote.balanceOf(address(this));
        uint256 equityUnits = equity.balanceOf(address(this));

        uint256 seniorGuarantee = accountant_.seniorGuaranteeQuote();
        if (!allowHaircut && quoteUnits < seniorGuarantee) revert SettlementNotReady();

        uint256 quoteToSenior = quoteUnits < seniorGuarantee ? quoteUnits : seniorGuarantee;
        uint256 quoteToJunior = quoteUnits - quoteToSenior;

        if (hSenior != 0) shareToken.burn(seniorVault, hSenior);
        if (hJunior != 0) shareToken.burn(juniorVault, hJunior);

        if (quoteToSenior != 0) quote.safeTransfer(seniorVault, quoteToSenior);
        if (quoteToJunior != 0) quote.safeTransfer(juniorVault, quoteToJunior);
        if (equityUnits != 0) equity.safeTransfer(juniorVault, equityUnits);

        ILedgerMaturedVault(seniorVault).creditSettlement(quoteToSenior, 0);
        ILedgerMaturedVault(juniorVault).creditSettlement(quoteToJunior, equityUnits);

        emit SettlementFinalized(hSenior, hJunior, quoteToSenior, quoteToJunior, equityUnits);
    }
}
