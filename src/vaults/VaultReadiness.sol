// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IVaultRead {
    function usdc() external view returns (address);
    function equity() external view returns (address);
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
    function seniorGuaranteeUsdc() external view returns (uint256);
    function seniorVault() external view returns (address);
    function juniorVault() external view returns (address);
}

interface ITrancheVaultRead {
    function totalPendingRedeemShares() external view returns (uint256);
}

interface IStrategyModuleRead {
    function totalLoopDebt() external view returns (uint256);
}

/// @notice Settlement preflight view for keepers (kept out of `RegimeVault` for EIP-170): what is
///         where, what is short, and whether `finalizeSettlement()` can run without a haircut.
contract VaultReadiness {
    struct SettlementReadiness {
        bool ready;
        bool halted;
        uint256 usdcUnits;
        uint256 equityUnits;
        uint256 seniorGuarantee;
        uint256 shortfall;
        uint256 pendingSeniorShares;
        uint256 pendingJuniorShares;
        uint256 loopDebt;
    }

    function settlementReadiness(address vault) external view returns (SettlementReadiness memory r) {
        r.halted = IHookRead(IVaultRead(vault).hook()).exited();
        r.usdcUnits = IERC20Lite(IVaultRead(vault).usdc()).balanceOf(vault);
        r.equityUnits = IERC20Lite(IVaultRead(vault).equity()).balanceOf(vault);

        address acct = IVaultRead(vault).accountant();
        if (acct != address(0)) {
            IAccountantRead accountant = IAccountantRead(acct);
            r.seniorGuarantee = accountant.seniorGuaranteeUsdc();
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
        if (module != address(0)) r.loopDebt = IStrategyModuleRead(module).totalLoopDebt();

        r.shortfall = r.seniorGuarantee > r.usdcUnits ? r.seniorGuarantee - r.usdcUnits : 0;
        r.ready = IVaultRead(vault).expired() && !IVaultRead(vault).settled() && acct != address(0) && r.shortfall == 0;
    }
}

interface IERC20Lite {
    function balanceOf(address account) external view returns (uint256);
}
