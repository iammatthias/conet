// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { Conet } from "../src/Conet.sol";
import { ConetFactory } from "../src/ConetFactory.sol";
import { DeployConetFactory } from "./DeployConetFactory.s.sol";

interface VmPins {
    function etch(address target, bytes calldata code) external;
}

contract Pins {
    VmPins private constant vm = VmPins(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes private constant CREATE2_DEPLOYER_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    function run()
        external
        returns (
            bytes32 targetSalt,
            address target,
            bytes32 targetInitCodeHash,
            bytes32 targetRuntimeHash,
            bytes32 factorySalt,
            address factory,
            bytes32 factoryInitCodeHash,
            bytes32 factoryRuntimeHash
        )
    {
        DeployConetFactory deployment = new DeployConetFactory();
        address deployer = deployment.CREATE2_DEPLOYER();
        vm.etch(deployer, CREATE2_DEPLOYER_RUNTIME);

        targetSalt = deployment.TARGET_SALT();
        bytes memory targetInitCode = type(Conet).creationCode;
        target = _deploy(deployer, targetSalt, targetInitCode);
        targetInitCodeHash = keccak256(targetInitCode);
        targetRuntimeHash = target.codehash;

        factorySalt = deployment.FACTORY_SALT();
        bytes memory factoryInitCode =
            abi.encodePacked(type(ConetFactory).creationCode, abi.encode(target));
        factory = _deploy(deployer, factorySalt, factoryInitCode);
        factoryInitCodeHash = keccak256(factoryInitCode);
        factoryRuntimeHash = factory.codehash;
    }

    function _deploy(address deployer, bytes32 salt, bytes memory initCode)
        private
        returns (address deployed)
    {
        (bool ok, bytes memory result) = deployer.call(abi.encodePacked(salt, initCode));
        require(ok && result.length == 20, "deterministic deployment failed");
        assembly ("memory-safe") {
            deployed := shr(96, mload(add(result, 0x20)))
        }
    }
}
