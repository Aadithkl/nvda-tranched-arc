// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IAToken } from "./interfaces/IAToken.sol";
import { IAaveV2Pool } from "./interfaces/IAaveV2Pool.sol";
import { WadRayMath } from "./libraries/WadRayMath.sol";

contract AToken is IAToken {
    using SafeERC20 for IERC20;

    string private _name;
    string private _symbol;
    uint8 private immutable _decimals;

    address public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;

    mapping(address => uint256) private _scaledBalances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _scaledTotalSupply;

    error NotPool(address caller);
    error InsufficientBalance(address user, uint256 amount);
    error InsufficientAllowance(address owner, address spender, uint256 amount);
    error InvalidAddress();

    modifier onlyPool() {
        if (msg.sender != POOL) revert NotPool(msg.sender);
        _;
    }

    constructor(address pool_, address underlying_, string memory name_, string memory symbol_, uint8 decimals_) {
        if (pool_ == address(0) || underlying_ == address(0)) revert InvalidAddress();
        POOL = pool_;
        UNDERLYING_ASSET_ADDRESS = underlying_;
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function balanceOf(address user) public view returns (uint256) {
        return WadRayMath.rayMul(_scaledBalances[user], _index());
    }

    function totalSupply() external view returns (uint256) {
        return WadRayMath.rayMul(_scaledTotalSupply, _index());
    }

    function scaledBalanceOf(address user) external view returns (uint256) {
        return _scaledBalances[user];
    }

    function scaledTotalSupply() external view returns (uint256) {
        return _scaledTotalSupply;
    }

    function allowance(address owner_, address spender) external view returns (uint256) {
        return _allowances[owner_][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transferScaled(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(from, msg.sender, amount);
            _allowances[from][msg.sender] = allowed - amount;
        }
        _transferScaled(from, to, amount);
        return true;
    }

    function mint(address user, uint256 amount) external onlyPool returns (bool) {
        uint256 scaled = WadRayMath.rayDiv(amount, _index());
        _scaledBalances[user] += scaled;
        _scaledTotalSupply += scaled;
        emit Transfer(address(0), user, amount);
        return true;
    }

    function burn(address user, uint256 amount) external onlyPool returns (bool) {
        uint256 scaled = WadRayMath.rayDiv(amount, _index());
        uint256 balance = _scaledBalances[user];
        if (scaled > balance) revert InsufficientBalance(user, amount);
        _scaledBalances[user] = balance - scaled;
        _scaledTotalSupply -= scaled;
        emit Transfer(user, address(0), amount);
        return true;
    }

    function transferUnderlyingTo(address target, uint256 amount) external onlyPool {
        IERC20(UNDERLYING_ASSET_ADDRESS).safeTransfer(target, amount);
    }

    function _transferScaled(address from, address to, uint256 amount) internal {
        uint256 scaled = WadRayMath.rayDiv(amount, _index());
        uint256 balance = _scaledBalances[from];
        if (scaled > balance) revert InsufficientBalance(from, amount);
        _scaledBalances[from] = balance - scaled;
        _scaledBalances[to] += scaled;
        emit Transfer(from, to, amount);
    }

    function _index() internal view returns (uint256) {
        return IAaveV2Pool(POOL).getReserveNormalizedIncome(UNDERLYING_ASSET_ADDRESS);
    }
}
