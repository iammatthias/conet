// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { Conet } from "../src/Conet.sol";

interface IConetV3 {
    function append(uint64 nonce, uint8 kind, bytes calldata cipher) external;
    function seq() external view returns (uint64);
    function factory() external view returns (address);
}

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function prank(address sender) external;
}

contract ConetTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant HEARD_TOPIC = keccak256("Heard(uint64,address,uint64,uint8,bytes)");

    Conet private station;

    function setUp() public {
        station = new Conet();
    }

    function testWireSelectorsPinTheV3Surface() public pure {
        _assertEqBytes4(IConetV3.append.selector, 0xe6d58bd6);
        _assertEqBytes4(IConetV3.seq.selector, 0x6857ab40);
        _assertEqBytes4(IConetV3.factory.selector, 0xc45a0155);
        _assertEqBytes4(Conet.EmptyCipher.selector, 0xd4ebf2e3);
        _assertEqBytes4(Conet.CipherTooLarge.selector, 0x6d234a07);
        _assertEqBytes32(
            HEARD_TOPIC, 0x7749f8171f4c205bdb0091272211daba89e23f60f9f9842d092ead135d8b01c3
        );
    }

    function testDeploysQuietWithNoStoredMaterial() public view {
        _assertEqUint(station.seq(), 0);
    }

    function testAppendEmitsTransmissionCarryingTheNonce() public {
        bytes memory cipher = hex"0102030405";

        vm.recordLogs();
        station.append(0x0123456789abcdef, 1, cipher);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _assertEqUint(station.seq(), 1);
        _assertEqUint(logs.length, 1);
        _assertEqAddress(logs[0].emitter, address(station));
        _assertEqUint(logs[0].topics.length, 3);
        _assertEqBytes32(logs[0].topics[0], HEARD_TOPIC);
        _assertEqUint(uint256(logs[0].topics[1]), 1);
        _assertEqAddress(address(uint160(uint256(logs[0].topics[2]))), address(this));

        (uint64 nonce, uint8 kind, bytes memory emittedCipher) =
            abi.decode(logs[0].data, (uint64, uint8, bytes));
        _assertEqUint(nonce, 0x0123456789abcdef);
        _assertEqUint8(kind, 1);
        _assertEqBytes(emittedCipher, cipher);
    }

    function testAppendAllowsBoundaryNoncesAndKinds() public {
        station.append(0, 0, hex"01");
        station.append(type(uint64).max, type(uint8).max, hex"02");

        _assertEqUint(station.seq(), 2);
    }

    function testAppendAllows2048ByteCipher() public {
        station.append(7, 2, new bytes(2048));
        _assertEqUint(station.seq(), 1);
    }

    function testAppendRejectsEmptyCipherWithoutAdvancing() public {
        (bool ok, bytes memory reason) =
            address(station).call(abi.encodeCall(Conet.append, (11, 0, bytes(""))));

        _assertFalse(ok);
        _assertEqBytes4(_selector(reason), Conet.EmptyCipher.selector);
        _assertEqUint(station.seq(), 0);
    }

    function testAppendRejectsOversizedCipherWithoutAdvancing() public {
        bytes memory cipher = new bytes(2049);
        (bool ok, bytes memory reason) =
            address(station).call(abi.encodeCall(Conet.append, (12, 0, cipher)));

        _assertFalse(ok);
        _assertEqBytes4(_selector(reason), Conet.CipherTooLarge.selector);
        _assertEqUint(abi.decode(_sliceAfterSelector(reason), (uint256)), 2049);
        _assertEqUint(station.seq(), 0);
    }

    function testRepeatedNonceIsNotRejectedByTheContract() public {
        station.append(99, 1, hex"aabb");
        station.append(99, 2, hex"cc");

        _assertEqUint(station.seq(), 2);
    }

    function testAnyCallerMayAppend() public {
        vm.prank(address(0xA11CE));
        station.append(1, 0, hex"0102");
        vm.prank(address(0xB0B));
        station.append(2, 1, hex"0304");

        _assertEqUint(station.seq(), 2);
    }

    function testFuzzAppendPreservesCipher(uint64 nonce, uint8 kind, bytes calldata cipher)
        public
    {
        if (cipher.length == 0 || cipher.length > 2048) return;

        vm.recordLogs();
        station.append(nonce, kind, cipher);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint64 emittedNonce, uint8 emittedKind, bytes memory emittedCipher) =
            abi.decode(logs[0].data, (uint64, uint8, bytes));

        _assertEqUint(emittedNonce, nonce);
        _assertEqUint8(emittedKind, kind);
        _assertEqBytes(emittedCipher, cipher);
    }

    function _selector(bytes memory data) private pure returns (bytes4 result) {
        if (data.length < 4) revert("missing selector");
        assembly ("memory-safe") {
            result := mload(add(data, 0x20))
        }
    }

    function _sliceAfterSelector(bytes memory data) private pure returns (bytes memory out) {
        if (data.length < 4) revert("missing selector");
        out = new bytes(data.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = data[i + 4];
        }
    }

    function _assertFalse(bool value) private pure {
        require(!value, "assert false failed");
    }

    function _assertEqUint(uint256 a, uint256 b) private pure {
        require(a == b, "uint mismatch");
    }

    function _assertEqUint8(uint8 a, uint8 b) private pure {
        require(a == b, "uint8 mismatch");
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

    function _assertEqBytes(bytes memory a, bytes memory b) private pure {
        require(keccak256(a) == keccak256(b), "bytes mismatch");
    }
}
