// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IMorpho, IMorphoOracle, IIrm } from "./IMorpho.sol";
import { IStrategyAdapter } from "./IStrategyAdapter.sol";

interface IMorphoLoopAdapter {
    function depositCollateral(uint256 amount) external;

    function borrowTo(uint256 amount, address to) external;

    function repayFrom(uint256 amount) external returns (uint256 repaid);

    function withdrawCollateralTo(uint256 amount, address to) external;

    function collateralToken() external view returns (address);

    function collateralBalance() external view returns (uint256);

    function collateralValue() external view returns (uint256);

    function collateralValueOf(uint256 amount) external view returns (uint256);

    function debt() external view returns (uint256);

    function exposure() external view returns (uint256);

    function healthFactor() external view returns (uint256);

    function badDebt() external view returns (uint256);

    function borrowAprBps() external view returns (uint256);
}

/// @notice Morpho Blue levered sleeve: collateralizes the vault's equity sleeve (stock token) and
///         borrows the quote asset against it within a conservative fraction of the market LLTV.
///         Junior risk capital only — NOT redemption-safe, excluded from the withdrawal path.
///         `realAssets()` reports this sleeve's equity (collateral value − debt, floored at zero)
///         so NAV double-counting is impossible: borrowed quote already sits in the vault/venues.
contract MorphoLoopAdapter is IStrategyAdapter, IMorphoLoopAdapter {
    using SafeERC20 for IERC20;

    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;
    uint256 internal constant WAD = 1e18;
    uint16 internal constant BPS = 10_000;

    address public immutable override authority;
    address public immutable override asset;
    address public immutable override collateralToken;
    IMorpho public immutable morpho;
    bytes32 public immutable marketId;
    /// @notice Fraction of the market LLTV the sleeve may borrow up to (e.g. 6000 = 60%).
    uint16 public immutable targetLtvOfLltvBps;
    /// @notice Floor health factor enforced on collateral withdrawals (WAD, >= 1).
    uint256 public immutable minHealthFactorWad;

    IMorpho.MarketParams internal _marketParams;

    event CollateralDeposited(uint256 amount);
    event Borrowed(uint256 amount, address to);
    event Repaid(uint256 amount);
    event CollateralWithdrawn(uint256 amount, address to);

    error AssetMismatch();
    error InvalidParams();
    error LtvExceeded(uint256 postDebt, uint256 maxDebt);
    error HealthTooLow(uint256 healthFactor, uint256 minimum);
    error NothingToRepay();

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority(msg.sender);
        _;
    }

    constructor(
        address authority_,
        address morpho_,
        IMorpho.MarketParams memory marketParams_,
        address asset_,
        uint16 targetLtvOfLltvBps_,
        uint256 minHealthFactorWad_
    ) {
        if (authority_ == address(0) || morpho_ == address(0) || asset_ == address(0)) {
            revert ZeroAddress();
        }
        if (marketParams_.loanToken != asset_) revert AssetMismatch();
        if (marketParams_.collateralToken == address(0)) revert InvalidParams();
        if (targetLtvOfLltvBps_ == 0 || targetLtvOfLltvBps_ > BPS) revert InvalidParams();
        if (minHealthFactorWad_ < WAD) revert InvalidParams();
        authority = authority_;
        morpho = IMorpho(morpho_);
        asset = asset_;
        collateralToken = marketParams_.collateralToken;
        targetLtvOfLltvBps = targetLtvOfLltvBps_;
        minHealthFactorWad = minHealthFactorWad_;
        _marketParams = marketParams_;
        marketId = keccak256(abi.encode(marketParams_));
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function marketParams() external view returns (IMorpho.MarketParams memory) {
        return _marketParams;
    }

    function collateralBalance() public view returns (uint256) {
        (,, uint128 collateral) = morpho.position(marketId, address(this));
        return uint256(collateral);
    }

    /// @notice Collateral value in loan-token units (Morpho oracle price is 1e36-scaled).
    function collateralValue() public view returns (uint256) {
        uint256 collateral = collateralBalance();
        if (collateral == 0) return 0;
        uint256 price = IMorphoOracle(_marketParams.oracle).price();
        return Math.mulDiv(collateral, price, 1e36);
    }

    function collateralValueOf(uint256 amount) external view returns (uint256) {
        if (amount == 0) return 0;
        return Math.mulDiv(amount, IMorphoOracle(_marketParams.oracle).price(), 1e36);
    }

    function debt() public view returns (uint256) {
        (, uint128 borrowShares,) = morpho.position(marketId, address(this));
        if (borrowShares == 0) return 0;
        IMorpho.Market memory m = morpho.market(marketId);
        return Math.mulDiv(
            uint256(borrowShares),
            uint256(m.totalBorrowAssets) + VIRTUAL_ASSETS,
            uint256(m.totalBorrowShares) + VIRTUAL_SHARES,
            Math.Rounding.Ceil
        );
    }

    /// @notice Levered exposure tracked against caps (collateral value in loan-token units).
    function exposure() public view returns (uint256) {
        return collateralValue();
    }

    function maxDebtAllowed(uint256 collateralValue_) public view returns (uint256) {
        uint256 lltvCap = Math.mulDiv(collateralValue_, _marketParams.lltv, WAD);
        return Math.mulDiv(lltvCap, targetLtvOfLltvBps, BPS);
    }

    function healthFactor() public view returns (uint256) {
        uint256 debt_ = debt();
        if (debt_ == 0) return type(uint256).max;
        uint256 maxDebt = Math.mulDiv(collateralValue(), _marketParams.lltv, WAD);
        return Math.mulDiv(maxDebt, WAD, debt_);
    }

    /// @notice Current Morpho borrow APR in bps (simple annualization of the IRM's
    ///         per-second WAD rate). Returns 0 when the market has no IRM or the read
    ///         is unavailable, so callers treat it as unknown rather than reverting NAV.
    function borrowAprBps() public view returns (uint256) {
        address irm = _marketParams.irm;
        if (irm == address(0)) return 0;
        try IIrm(irm).borrowRateView(_marketParams, morpho.market(marketId)) returns (uint256 ratePerSecondWad) {
            return Math.mulDiv(ratePerSecondWad, 365 days * 10_000, WAD);
        } catch {
            return 0;
        }
    }

    /// @notice Sleeve equity: idle quote + collateral value − debt, floored at zero.
    function realAssets() public view returns (uint256) {
        uint256 value = IERC20(asset).balanceOf(address(this)) + collateralValue();
        uint256 debt_ = debt();
        return value > debt_ ? value - debt_ : 0;
    }

    /// @notice Unsecured shortfall when debt exceeds collateral + idle quote. Reported
    ///         separately so the vault can subtract it from NAV instead of silently
    ///         flooring negative equity to zero.
    function badDebt() public view returns (uint256) {
        uint256 value = IERC20(asset).balanceOf(address(this)) + collateralValue();
        uint256 debt_ = debt();
        return debt_ > value ? debt_ - value : 0;
    }

    /// @notice Only idle quote can leave without unwinding the loop.
    function maxWithdrawable() public view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    // ------------------------------------------------------------------
    // IStrategyAdapter (USDG side)
    // ------------------------------------------------------------------

    /// @dev Quote allocator: pulls quote and repays outstanding debt first; remainder stays idle.
    function deposit(uint256 amount) external onlyAuthority returns (uint256 deployed) {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset).safeTransferFrom(authority, address(this), amount);
        uint256 debt_ = debt();
        uint256 repaid;
        if (debt_ != 0) {
            uint256 repayAmount = amount < debt_ ? amount : debt_;
            IERC20(asset).forceApprove(address(morpho), repayAmount);
            (repaid,) = morpho.repay(_marketParams, repayAmount, 0, address(this), "");
            IERC20(asset).forceApprove(address(morpho), 0);
            emit Repaid(repaid);
        }
        deployed = amount - repaid;
    }

    function withdraw(uint256 amount, address to) external onlyAuthority returns (uint256 withdrawn) {
        if (to == address(0)) revert ZeroAddress();
        uint256 idle = IERC20(asset).balanceOf(address(this));
        withdrawn = amount < idle ? amount : idle;
        if (withdrawn != 0) IERC20(asset).safeTransfer(to, withdrawn);
    }

    /// @notice Full unwind: repays all debt (pulling the needed quote from the authority), withdraws
    ///         all collateral and idle quote to `to`.
    function exit(uint256, address to) external onlyAuthority returns (uint256 withdrawn) {
        if (to == address(0)) revert ZeroAddress();
        (, uint128 borrowShares,) = morpho.position(marketId, address(this));
        if (borrowShares != 0) {
            uint256 owedAssets = debt();
            uint256 balance = IERC20(asset).balanceOf(address(this));
            uint256 need = owedAssets > balance ? owedAssets - balance : 0;
            if (need != 0) {
                IERC20(asset).safeTransferFrom(authority, address(this), need);
            }
            IERC20(asset).forceApprove(address(morpho), owedAssets);
            morpho.repay(_marketParams, 0, uint256(borrowShares), address(this), "");
            IERC20(asset).forceApprove(address(morpho), 0);
        }
        uint256 collateral = collateralBalance();
        if (collateral != 0) morpho.withdrawCollateral(_marketParams, collateral, address(this), to);
        uint256 idle = IERC20(asset).balanceOf(address(this));
        if (idle != 0) IERC20(asset).safeTransfer(to, idle);
        // The funds pulled from the authority repaid debt and never reach `to`; report
        // only the quote actually transferred out.
        withdrawn = idle;
    }

    // ------------------------------------------------------------------
    // Loop operations (module only)
    // ------------------------------------------------------------------

    function depositCollateral(uint256 amount) external onlyAuthority {
        if (amount == 0) revert ZeroAmount();
        IERC20(collateralToken).safeTransferFrom(authority, address(this), amount);
        IERC20(collateralToken).forceApprove(address(morpho), amount);
        morpho.supplyCollateral(_marketParams, amount, address(this), "");
        IERC20(collateralToken).forceApprove(address(morpho), 0);
        emit CollateralDeposited(amount);
    }

    function borrowTo(uint256 amount, address to) external onlyAuthority {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 postDebt = debt() + amount;
        uint256 maxDebt = maxDebtAllowed(collateralValue());
        if (postDebt > maxDebt) revert LtvExceeded(postDebt, maxDebt);
        morpho.borrow(_marketParams, amount, 0, address(this), to);
        emit Borrowed(amount, to);
    }

    function repayFrom(uint256 amount) external onlyAuthority returns (uint256 repaid) {
        uint256 debt_ = debt();
        if (debt_ == 0) revert NothingToRepay();
        amount = amount < debt_ ? amount : debt_;
        IERC20(asset).safeTransferFrom(authority, address(this), amount);
        IERC20(asset).forceApprove(address(morpho), amount);
        (repaid,) = morpho.repay(_marketParams, amount, 0, address(this), "");
        IERC20(asset).forceApprove(address(morpho), 0);
        emit Repaid(repaid);
    }

    function withdrawCollateralTo(uint256 amount, address to) external onlyAuthority {
        if (to == address(0)) revert ZeroAddress();
        uint256 debt_ = debt();
        if (debt_ != 0) {
            uint256 remainingValue = collateralValue() - Math.mulDiv(amount, collateralValue(), collateralBalance());
            uint256 maxDebt = Math.mulDiv(Math.mulDiv(remainingValue, _marketParams.lltv, WAD), targetLtvOfLltvBps, BPS);
            if (debt_ > maxDebt) revert HealthTooLow(healthFactor(), minHealthFactorWad);
            uint256 hf = Math.mulDiv(Math.mulDiv(remainingValue, _marketParams.lltv, WAD), WAD, debt_);
            if (hf < minHealthFactorWad) revert HealthTooLow(hf, minHealthFactorWad);
        }
        morpho.withdrawCollateral(_marketParams, amount, address(this), to);
        emit CollateralWithdrawn(amount, to);
    }
}
