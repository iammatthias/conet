// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { Conet } from "../src/Conet.sol";
import { ConetFactory } from "../src/ConetFactory.sol";

interface VmConetFactoryBroadcast {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys the permissionless Conet factory on the selected Foundry RPC.
contract DeployConetFactory {
    error Create2DeployerUnavailable(
        address deployer, bytes32 expectedCodeHash, bytes32 actualCodeHash
    );
    error FactoryAddressChanged(address expected, address actual);
    error TargetAddressChanged(address expected, address actual);
    error FactoryDeploymentFailed(bytes reason);
    error UnexpectedDeploymentResult(address expected, address actual);
    error UnexpectedFactoryCode(address factory, address expectedTarget, address actualTarget);

    VmConetFactoryBroadcast private constant vm =
        VmConetFactoryBroadcast(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Canonical deterministic deployment proxy used by Foundry and other tooling.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 public constant CREATE2_DEPLOYER_CODE_HASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    /// @dev A namespace, not a vanity target. No salt grinding is performed.
    bytes32 public constant TARGET_SALT = keccak256("conet.target.v3");
    bytes32 public constant FACTORY_SALT = keccak256("conet.factory.v3");
    address public constant TARGET_ADDRESS = 0x3560E9576a9E2D3D073BbB759bF379531C5Ca3d3;
    address public constant FACTORY_ADDRESS = 0xB084351e5Fd70d318a2264Bc8af63C4575Db8844;

    function run() external returns (ConetFactory factory) {
        vm.startBroadcast();
        factory = deploy();
        vm.stopBroadcast();
    }

    /// @notice Returns the cross-chain target rendezvous for the frozen init code and salt.
    function predictedTarget() public pure returns (address) {
        return _create2(TARGET_SALT, keccak256(type(Conet).creationCode));
    }

    /// @notice Returns the cross-chain factory rendezvous. The target address is a
    ///         constructor argument, so a different foundation yields a different factory.
    function predictedFactory() public pure returns (address) {
        return _create2(
            FACTORY_SALT,
            keccak256(
                abi.encodePacked(type(ConetFactory).creationCode, abi.encode(predictedTarget()))
            )
        );
    }

    function _create2(bytes32 salt, bytes32 initCodeHash) private pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash))
                )
            )
        );
    }

    /// @notice Deploys once through the canonical proxy, or returns the verified deployment.
    /// @dev Exposed separately so the deterministic path can be exercised in Foundry tests.
    function deploy() public returns (ConetFactory factory) {
        _deployTarget();
        address expected = predictedFactory();
        if (expected != FACTORY_ADDRESS) revert FactoryAddressChanged(FACTORY_ADDRESS, expected);
        if (expected.code.length != 0) {
            _requireFactoryFoundation(expected);
            return ConetFactory(expected);
        }

        bytes32 deployerCodeHash = CREATE2_DEPLOYER.codehash;
        if (deployerCodeHash != CREATE2_DEPLOYER_CODE_HASH) {
            revert Create2DeployerUnavailable(
                CREATE2_DEPLOYER, CREATE2_DEPLOYER_CODE_HASH, deployerCodeHash
            );
        }

        (bool ok, bytes memory result) = CREATE2_DEPLOYER.call(
            abi.encodePacked(
                FACTORY_SALT, type(ConetFactory).creationCode, abi.encode(predictedTarget())
            )
        );
        if (!ok) revert FactoryDeploymentFailed(result);

        address actual = _returnedAddress(result);
        if (actual != expected) revert UnexpectedDeploymentResult(expected, actual);

        _requireFactoryFoundation(expected);
        factory = ConetFactory(expected);
    }

    function _deployTarget() private {
        address expected = predictedTarget();
        if (expected != TARGET_ADDRESS) revert TargetAddressChanged(TARGET_ADDRESS, expected);
        if (expected.code.length != 0) return;

        bytes32 deployerCodeHash = CREATE2_DEPLOYER.codehash;
        if (deployerCodeHash != CREATE2_DEPLOYER_CODE_HASH) {
            revert Create2DeployerUnavailable(
                CREATE2_DEPLOYER, CREATE2_DEPLOYER_CODE_HASH, deployerCodeHash
            );
        }

        (bool ok, bytes memory result) =
            CREATE2_DEPLOYER.call(abi.encodePacked(TARGET_SALT, type(Conet).creationCode));
        if (!ok) revert FactoryDeploymentFailed(result);
        if (_returnedAddress(result) != expected) {
            revert UnexpectedDeploymentResult(expected, _returnedAddress(result));
        }
    }

    function _requireFactoryFoundation(address factory) private view {
        address expected = predictedTarget();
        (bool ok, bytes memory result) = factory.staticcall(abi.encodeWithSignature("target()"));
        if (!ok || result.length != 32) revert UnexpectedFactoryCode(factory, expected, address(0));

        address foundation = abi.decode(result, (address));
        if (foundation != expected) revert UnexpectedFactoryCode(factory, expected, foundation);
    }

    function _returnedAddress(bytes memory result) private pure returns (address deployed) {
        if (result.length != 20) return address(0);
        assembly ("memory-safe") {
            deployed := shr(96, mload(add(result, 0x20)))
        }
    }
}
