// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IVaultDepeg {
    function lastDepegCheck() external view returns (uint256);
    function checkDepeg() external returns (bool);
}

interface IHookSession {
    function oracleStatus() external view returns (bool ok, uint256 updatedAt, uint8 session);
}

/// @notice Provider-agnostic depeg heartbeat.
///
///         Chainlink Automation is deprecated and does not cover Robinhood Chain (4663);
///         Gelato, CRE, or a plain bot can all drive this contract. It exposes the standard
///         `checkUpkeep`/`performUpkeep` pair plus Gelato's `checker()` shape, so the
///         provider can be swapped without touching the vault.
///
///         Cadence: faster while the stock market session is open (the reference feed is
///         live and the book can trade), slower when closed (the check is a no-op anyway,
///         because a stale stock feed leaves the latch untouched).
///
///         `performUpkeep` is permissionless by design: the vault's `checkDepeg` is the
///         safety gate, and it only latches on a TWAP-vs-stock divergence sustained for
///         `minDuration`, so a caller cannot grief it. Register this contract as the
///         vault's `depegKeeper` (the main keeper keeps its own access).
contract DepegHeartbeat {
    IVaultDepeg public immutable vault;
    IHookSession public immutable hook;
    uint32 public immutable intervalOpen;
    uint32 public immutable intervalClosed;

    constructor(address vault_, address hook_, uint32 intervalOpen_, uint32 intervalClosed_) {
        require(vault_ != address(0) && hook_ != address(0), "zero");
        require(intervalOpen_ != 0 && intervalClosed_ != 0, "interval");
        vault = IVaultDepeg(vault_);
        hook = IHookSession(hook_);
        intervalOpen = intervalOpen_;
        intervalClosed = intervalClosed_;
    }

    /// @notice Seconds until the next heartbeat, based on the current session.
    function interval() public view returns (uint32) {
        (bool ok,, uint8 session) = hook.oracleStatus();
        return ok && session != 0 ? intervalOpen : intervalClosed;
    }

    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 last = vault.lastDepegCheck();
        upkeepNeeded = last == 0 || block.timestamp >= last + interval();
        performData = "";
    }

    function performUpkeep(bytes calldata) external {
        vault.checkDepeg();
    }

    /// @notice Gelato resolver shape (`checker`), same decision as `checkUpkeep`.
    function checker() external view returns (bool canExec, bytes memory execPayload) {
        uint256 last = vault.lastDepegCheck();
        canExec = last == 0 || block.timestamp >= last + interval();
        execPayload = abi.encodeCall(DepegHeartbeat.performUpkeep, (""));
    }
}
