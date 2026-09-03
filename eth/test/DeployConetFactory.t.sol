// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { DeployConetFactory } from "../script/DeployConetFactory.s.sol";
import { ConetFactory } from "../src/ConetFactory.sol";

interface VmDeterministicConetFactoryTest {
    function etch(address target, bytes calldata code) external;
}

contract DeployConetFactoryTest {
    VmDeterministicConetFactoryTest private constant vm =
        VmDeterministicConetFactoryTest(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address private constant EXPECTED_FACTORY = 0xB084351e5Fd70d318a2264Bc8af63C4575Db8844;
    bytes private constant CREATE2_DEPLOYER_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    DeployConetFactory private deployment;

    function setUp() public {
        vm.etch(CREATE2_DEPLOYER, CREATE2_DEPLOYER_RUNTIME);
        deployment = new DeployConetFactory();
    }

    function testPredictionPinsSaltDeployerAndFactoryInitCode() public view {
        _assertEqAddress(deployment.predictedFactory(), EXPECTED_FACTORY);
        _assertEqAddress(deployment.FACTORY_ADDRESS(), EXPECTED_FACTORY);
        _assertEqBytes32(
            keccak256(
                abi.encodePacked(
                    type(ConetFactory).creationCode, abi.encode(deployment.predictedTarget())
                )
            ),
            0x8bc323a2d2159dcc66435f2fe92a25554e687543f1004116ca4ed1620c7615ed
        );
        _assertEqAddress(deployment.predictedTarget(), deployment.TARGET_ADDRESS());
        _assertEqBytes32(
            deployment.FACTORY_SALT(),
            0xe2a24f550c5cb1b45f5f0d852f6437fc70fa99502e84a4d2451d8b1a1b6348fd
        );
        _assertEqBytes32(
            deployment.CREATE2_DEPLOYER_CODE_HASH(),
            0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989
        );
    }

    function testDeployUsesCanonicalProxyAtPredictedAddress() public {
        ConetFactory factory = deployment.deploy();

        _assertEqAddress(address(factory), EXPECTED_FACTORY);
        _assertEqBytes32(
            address(factory).codehash,
            0x80b1eb5c1f812d2e9c7881570c9a9a704ba18c867d6de54e2a4f6bce07518ab2
        );
        _assertEqAddress(factory.target(), deployment.predictedTarget());
        _assertEqBytes32(
            factory.target().codehash,
            0xfb176cda17cba1bdbb54c7df65e0323ceb0d1ed01b998713ca606ad2ae0afe1b
        );
        _assertEqUint(factory.stationCount(), 0);
    }

    function testDeployReturnsExistingVerifiedFactory() public {
        ConetFactory first = deployment.deploy();
        first.mint();
        ConetFactory second = deployment.deploy();

        _assertEqAddress(address(first), address(second));
        _assertEqAddress(address(second), EXPECTED_FACTORY);
        _assertEqUint(second.stationCount(), 1);
    }

    function testDeployRejectsMissingCanonicalProxy() public {
        vm.etch(CREATE2_DEPLOYER, bytes(""));

        (bool ok, bytes memory reason) =
            address(deployment).call(abi.encodeCall(DeployConetFactory.deploy, ()));

        _assertFalse(ok);
        _assertEqBytes4(_selector(reason), DeployConetFactory.Create2DeployerUnavailable.selector);
    }

    function testDeployRejectsUnexpectedCanonicalProxyCode() public {
        vm.etch(CREATE2_DEPLOYER, hex"00");

        (bool ok, bytes memory reason) =
            address(deployment).call(abi.encodeCall(DeployConetFactory.deploy, ()));

        _assertFalse(ok);
        _assertEqBytes4(_selector(reason), DeployConetFactory.Create2DeployerUnavailable.selector);
    }

    function testDeployRejectsUnexpectedCodeAtFactoryAddress() public {
        vm.etch(EXPECTED_FACTORY, hex"00");

        (bool ok, bytes memory reason) =
            address(deployment).call(abi.encodeCall(DeployConetFactory.deploy, ()));

        _assertFalse(ok);
        _assertEqBytes4(_selector(reason), DeployConetFactory.UnexpectedFactoryCode.selector);
    }

    function _selector(bytes memory data) private pure returns (bytes4 result) {
        if (data.length < 4) revert("missing selector");
        assembly ("memory-safe") {
            result := mload(add(data, 0x20))
        }
    }

    function _assertFalse(bool value) private pure {
        require(!value, "assert false failed");
    }

    function _assertEqUint(uint256 a, uint256 b) private pure {
        require(a == b, "uint mismatch");
    }

    function _assertEqBytes4(bytes4 a, bytes4 b) private pure {
        require(a == b, "selector mismatch");
    }

    function _assertEqBytes32(bytes32 a, bytes32 b) private pure {
        require(a == b, "bytes32 mismatch");
    }

    function _assertEqAddress(address a, address b) private pure {
        require(a == b, "address mismatch");
    }
}
