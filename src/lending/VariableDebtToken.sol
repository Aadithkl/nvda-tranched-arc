// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IVariableDebtToken } from "./interfaces/IVariableDebtToken.sol";
import { IAaveV2Pool } from "./interfaces/IAaveV2Pool.sol";
import { WadRayMath } from "./libraries/WadRayMath.sol";

contract VariableDebtToken is IVariableDebtToken {
    address public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;

    mapping(address => uint256) private _scaledBalances;
    uint256 private _scaledTotalSupply;

    error NotPool(address caller);
    error InsufficientBalance(address user, uint256 amount);
    error InvalidAddress();

    modifier onlyPool() {
        if (msg.sender != POOL) revert NotPool(msg.sender);
        _;
    }

    constructor(address pool_, address underlying_) {
        if (pool_ == address(0) || underlying_ == address(0)) revert InvalidAddress();
        POOL = pool_;
        UNDERLYING_ASSET_ADDRESS = underlying_;
    }

    function balanceOf(address user) external view returns (uint256) {
        return WadRayMath.rayMul(_scaledBalances[user], _index());
    }

    function scaledBalanceOf(address user) external view returns (uint256) {
        return _scaledBalances[user];
    }

    function totalSupply() external view returns (uint256) {
        return WadRayMath.rayMul(_scaledTotalSupply, _index());
    }

    function scaledTotalSupply() external view returns (uint256) {
        return _scaledTotalSupply;
    }

    function mint(address user, uint256 amount) external onlyPool returns (bool) {
        uint256 scaled = WadRayMath.rayDiv(amount, _index());
        _scaledBalances[user] += scaled;
        _scaledTotalSupply += scaled;
        return true;
    }

    function burn(address user, uint256 amount) external onlyPool returns (bool) {
        uint256 scaled = WadRayMath.rayDiv(amount, _index());
        uint256 balance = _scaledBalances[user];
        if (scaled > balance) revert InsufficientBalance(user, amount);
        _scaledBalances[user] = balance - scaled;
        _scaledTotalSupply -= scaled;
        return true;
    }

    function _index() internal view returns (uint256) {
        return IAaveV2Pool(POOL).getReserveNormalizedVariableDebt(UNDERLYING_ASSET_ADDRESS);
    }
}
