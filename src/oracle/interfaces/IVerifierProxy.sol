// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IVerifierProxy {
    function verify(bytes calldata payload, bytes calldata parameterPayload) external payable returns (bytes memory);

    function s_feeManager() external view returns (address);
}
