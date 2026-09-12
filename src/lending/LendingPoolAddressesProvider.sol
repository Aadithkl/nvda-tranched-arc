// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ILendingPoolAddressesProvider } from "./interfaces/ILendingPoolAddressesProvider.sol";

contract LendingPoolAddressesProvider is Ownable, ILendingPoolAddressesProvider {
    bytes32 public constant LENDING_POOL = keccak256("LENDING_POOL");
    bytes32 public constant LENDING_POOL_CONFIGURATOR = keccak256("LENDING_POOL_CONFIGURATOR");
    bytes32 public constant PRICE_ORACLE = keccak256("PRICE_ORACLE");
    bytes32 public constant PROTOCOL_DATA_PROVIDER = keccak256("PROTOCOL_DATA_PROVIDER");

    string public marketId;

    mapping(bytes32 => address) private _addresses;
    address private _poolAdmin;

    event AddressSet(bytes32 indexed id, address indexed newAddress);
    event PoolAdminUpdated(address indexed poolAdmin);

    error ZeroAddress();

    constructor(string memory marketId_) Ownable(msg.sender) {
        marketId = marketId_;
        _poolAdmin = msg.sender;
    }

    function setAddress(bytes32 id, address newAddress) external onlyOwner {
        if (newAddress == address(0)) revert ZeroAddress();
        _addresses[id] = newAddress;
        emit AddressSet(id, newAddress);
    }

    function setPoolAdmin(address poolAdmin) external onlyOwner {
        if (poolAdmin == address(0)) revert ZeroAddress();
        _poolAdmin = poolAdmin;
        emit PoolAdminUpdated(poolAdmin);
    }

    function getAddress(bytes32 id) public view returns (address) {
        return _addresses[id];
    }

    function getPoolAdmin() external view returns (address) {
        return _poolAdmin;
    }

    function getLendingPool() external view returns (address) {
        return _addresses[LENDING_POOL];
    }

    function getLendingPoolConfigurator() external view returns (address) {
        return _addresses[LENDING_POOL_CONFIGURATOR];
    }

    function getPriceOracle() external view returns (address) {
        return _addresses[PRICE_ORACLE];
    }
}
