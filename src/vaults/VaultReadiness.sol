// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IVaultRead {
    function quote() external view returns (address);
    function equity() external view returns (address);
    function aToken() external view returns (address);
    function hook() external view returns (address);
    function accountant() external view returns (address);
    function strategyModule() external view returns (address);
    function expired() external view returns (bool);
    function settled() external view returns (bool);
}

interface IHookRead {
    function exited() external view returns (bool);
}

interface IAccountantRead {
    function seniorGuaranteeQuote() external view returns (uint256);
    function seniorVault() external view returns (address);
    function juniorVault() external view returns (address);
}

interface ITrancheVaultRead {
    function totalPendingRedeemShares() external view returns (uint256);
}

interface IStrategyModuleRead {
    function totalLoopDebt() external view returns (uint256);
    function pullableAssets() external view returns (uint256);
}

/// @notice Settlement preflight view for keepers (kept out of `LedgerVault` for EIP-170): what is
///         where, what is short, and whether `finalizeSettlement()` can run without a haircut.
contract VaultReadiness {
    struct SettlementReadiness {
        bool ready;
        bool halted;
        uint256 quoteUnits;
        uint256 equityUnits;
        uint256 seniorGuarantee;
        uint256 shortfall;
        uint256 pendingSeniorShares;
        uint256 pendingJuniorShares;
        uint256 loopDebt;
    }

    function settlementReadiness(address vault) external view returns (SettlementReadiness memory r) {
        r.halted = IHookRead(IVaultRead(vault).hook()).exited();
        r.quoteUnits = IERC20Lite(IVaultRead(vault).quote()).balanceOf(vault);
        r.equityUnits = IERC20Lite(IVaultRead(vault).equity()).balanceOf(vault);
        address aToken = IVaultRead(vault).aToken();
        if (aToken != address(0)) r.quoteUnits += IERC20Lite(aToken).balanceOf(vault);

        address acct = IVaultRead(vault).accountant();
        if (acct != address(0)) {
            IAccountantRead accountant = IAccountantRead(acct);
            r.seniorGuarantee = accountant.seniorGuaranteeQuote();
            address seniorVault = accountant.seniorVault();
            address juniorVault = accountant.juniorVault();
            if (seniorVault != address(0)) {
                r.pendingSeniorShares = ITrancheVaultRead(seniorVault).totalPendingRedeemShares();
            }
            if (juniorVault != address(0)) {
                r.pendingJuniorShares = ITrancheVaultRead(juniorVault).totalPendingRedeemShares();
            }
        }

        address module = IVaultRead(vault).strategyModule();
        if (module != address(0)) {
            r.loopDebt = IStrategyModuleRead(module).totalLoopDebt();
            r.quoteUnits += IStrategyModuleRead(module).pullableAssets();
        }

        // Loop debt is repaid from quote before the senior guarantee is paid, so both
        // must be covered by the quote the vault can actually reach.
        uint256 needed = r.seniorGuarantee + r.loopDebt;
        r.shortfall = needed > r.quoteUnits ? needed - r.quoteUnits : 0;
        r.ready = IVaultRead(vault).expired() && !IVaultRead(vault).settled() && acct != address(0) && r.shortfall == 0;
    }
}

interface IERC20Lite {
    function balanceOf(address account) external view returns (uint256);
}
