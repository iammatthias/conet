// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { Conet } from "./Conet.sol";

/// @title ConetFactory
/// @notice Permissionlessly mints immutable Conet frequencies as clones of one fixed target.
contract ConetFactory {
    error TargetNotContract();
    error CloneFailed();

    address public immutable target;

    uint64 public stationCount;
    mapping(address => uint64) public stationId;

    event StationMinted(uint64 indexed stationId, address indexed station, address indexed creator);

    constructor(address conetTarget) {
        if (conetTarget.code.length == 0) revert TargetNotContract();
        target = conetTarget;
    }

    /// @notice Mints a new Conet frequency and announces it.
    function mint() external returns (Conet station) {
        station = Conet(_clone(target));
        station.initialize();

        uint64 id = ++stationCount;
        stationId[address(station)] = id;

        emit StationMinted(id, address(station), msg.sender);
    }

    function _clone(address implementation) private returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(
                add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000
            )
            instance := create(0, ptr, 0x37)
        }
        if (instance == address(0)) revert CloneFailed();
    }
}
