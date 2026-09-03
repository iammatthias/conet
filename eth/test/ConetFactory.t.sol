// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { Conet } from "../src/Conet.sol";
import { ConetFactory } from "../src/ConetFactory.sol";

interface IConetFactoryV0 {
    function mint() external returns (address station);
    function stationCount() external view returns (uint64);
}

interface VmFactoryTest {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract ConetFactoryTest {
    VmFactoryTest private constant vm =
        VmFactoryTest(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant MINTED_TOPIC = keccak256("StationMinted(uint64,address,address)");
    bytes32 private constant HEARD_TOPIC = keccak256("Heard(uint64,address,uint64,uint8,bytes)");
    Conet private target;
    ConetFactory private factory;

    function setUp() public {
        target = new Conet();
        factory = new ConetFactory(address(target));
    }

    function testWireSelectorsPinTheRegistrySurface() public pure {
        _assertEqBytes4(IConetFactoryV0.mint.selector, 0x1249c58b);
        _assertEqBytes4(IConetFactoryV0.stationCount.selector, 0xda36d3db);
        _assertEqBytes32(
            MINTED_TOPIC, 0x85ef9f965ffa3c76ec40074d335407047a2a04adc5e7e4981b41b26297da2631
        );
    }

    function testMintCreatesStationAndAnnouncesIt() public {
        address creator = address(0xA11CE);

        vm.recordLogs();
        vm.prank(creator);
        Conet station = factory.mint();
        VmFactoryTest.Log[] memory logs = vm.getRecordedLogs();

        _assertEqUint(factory.stationCount(), 1);
        _assertEqUint(station.seq(), 0);

        VmFactoryTest.Log memory minted = logs[logs.length - 1];
        _assertEqAddress(minted.emitter, address(factory));
        _assertEqUint(minted.topics.length, 4);
        _assertEqBytes32(minted.topics[0], MINTED_TOPIC);
        _assertEqUint(uint256(minted.topics[1]), 1);
        _assertEqAddress(address(uint160(uint256(minted.topics[2]))), address(station));
        _assertEqAddress(address(uint160(uint256(minted.topics[3]))), creator);
        _assertEqUint(minted.data.length, 0);
    }

    function testEveryMintCreatesADistinctStation() public {
        Conet first = factory.mint();
        Conet second = factory.mint();

        _assertTrue(address(first) != address(second));
        _assertEqUint(factory.stationCount(), 2);
    }

    function testStationIdsAdvanceInMintOrder() public {
        vm.recordLogs();
        factory.mint();
        factory.mint();
        VmFactoryTest.Log[] memory logs = vm.getRecordedLogs();

        _assertEqUint(logs.length, 2);
        _assertEqUint(uint256(logs[0].topics[1]), 1);
        _assertEqUint(uint256(logs[1].topics[1]), 2);
    }

    function testConetCreationBytecodeIsPinned() public pure {
        _assertEqBytes32(
            keccak256(type(Conet).creationCode),
            0x97915f6ede15da587e5d71827404652109db682ff865f3ec6626e2386e9fbd77
        );
    }

    function testConstructorRejectsTargetWithoutCode() public {
        try new ConetFactory(address(0xdead)) returns (ConetFactory) {
            revert("constructor accepted a target without code");
        } catch (bytes memory reason) {
            _assertEqBytes4(_selector(reason), ConetFactory.TargetNotContract.selector);
        }
    }

    function testTargetIsFixedAtConstruction() public view {
        _assertEqAddress(factory.target(), address(target));
    }

    function testStationIdAnswersProvenanceForMintedStationsOnly() public {
        Conet first = factory.mint();
        Conet second = factory.mint();

        _assertEqUint(factory.stationId(address(first)), 1);
        _assertEqUint(factory.stationId(address(second)), 2);
        _assertEqUint(factory.stationId(address(target)), 0);
        _assertEqUint(factory.stationId(address(0xdead)), 0);
    }

    function testMintedStationIsAMinimalProxyBoundToTheFactory() public {
        Conet station = factory.mint();

        _assertEqBytes(
            address(station).code,
            abi.encodePacked(
                hex"363d3d373d3d3d363d73", address(target), hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        _assertEqAddress(station.factory(), address(factory));
    }

    function testMintedStationCannotBeInitializedAgain() public {
        Conet station = factory.mint();

        (bool ok, bytes memory reason) = address(station).call(abi.encodeCall(Conet.initialize, ()));

        _assertFalse(ok);
        _assertEqBytes4(_selector(reason), Conet.AlreadyInitialized.selector);
        _assertEqAddress(station.factory(), address(factory));
    }

    function testStationsKeepStateApartFromEachOtherAndFromTheTarget() public {
        Conet first = factory.mint();
        Conet second = factory.mint();

        first.append(5, 1, hex"01");

        _assertEqUint(first.seq(), 1);
        _assertEqUint(second.seq(), 0);
        _assertEqUint(target.seq(), 0);
    }

    function testStationAppendEmitsHeardFromTheCloneNamingTheWriter() public {
        Conet station = factory.mint();
        address writer = address(0xA11CE);

        vm.recordLogs();
        vm.prank(writer);
        station.append(9, 1, hex"aabb");
        VmFactoryTest.Log[] memory logs = vm.getRecordedLogs();

        _assertEqUint(logs.length, 1);
        _assertEqAddress(logs[0].emitter, address(station));
        _assertEqBytes32(logs[0].topics[0], HEARD_TOPIC);
        _assertEqUint(uint256(logs[0].topics[1]), 1);
        _assertEqAddress(address(uint160(uint256(logs[0].topics[2]))), writer);
    }

    function testTargetIsLockedAgainstInitializationYetAcceptsAppends() public {
        (bool ok, bytes memory reason) = address(target).call(abi.encodeCall(Conet.initialize, ()));

        _assertFalse(ok);
        _assertEqBytes4(_selector(reason), Conet.AlreadyInitialized.selector);
        _assertEqAddress(target.factory(), address(target));

        target.append(1, 0, hex"01");

        _assertEqUint(target.seq(), 1);
        _assertEqUint(factory.stationId(address(target)), 0);
    }

    function testFuzzAnyCreatorMayMint(address creator) public {
        vm.recordLogs();
        vm.prank(creator);
        Conet station = factory.mint();
        VmFactoryTest.Log[] memory logs = vm.getRecordedLogs();

        _assertEqUint(factory.stationCount(), 1);
        _assertEqUint(station.seq(), 0);
        _assertEqAddress(address(uint160(uint256(logs[0].topics[3]))), creator);
    }

    function _selector(bytes memory data) private pure returns (bytes4 result) {
        if (data.length < 4) revert("missing selector");
        assembly ("memory-safe") {
            result := mload(add(data, 0x20))
        }
    }

    function _assertTrue(bool value) private pure {
        require(value, "assert true failed");
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

    function _assertEqBytes(bytes memory a, bytes memory b) private pure {
        require(keccak256(a) == keccak256(b), "bytes mismatch");
    }
}
