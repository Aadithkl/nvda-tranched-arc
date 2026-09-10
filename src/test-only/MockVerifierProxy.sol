// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IVerifierProxy } from "../oracle/interfaces/IVerifierProxy.sol";

contract MockVerifierProxy is IVerifierProxy {
    bytes public response;
    uint256 public verifyCalls;

    function setResponse(bytes calldata response_) external {
        response = response_;
    }

    function verify(bytes calldata, bytes calldata) external payable returns (bytes memory) {
        verifyCalls++;
        return response;
    }

    function s_feeManager() external pure returns (address) {
        return address(0);
    }
}
