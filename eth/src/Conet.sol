// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title Conet
/// @notice An immutable, append-only event log carrying ciphertext transmissions.
contract Conet {
    error EmptyCipher();
    error CipherTooLarge(uint256 length);
    error AlreadyInitialized();

    address public factory;

    uint64 public seq;

    event Heard(uint64 indexed seq, address indexed writer, uint64 nonce, uint8 kind, bytes cipher);

    constructor() {
        factory = address(this);
    }

    /// @notice Binds a freshly cloned Station to the factory that minted it.
    function initialize() external {
        if (factory != address(0)) revert AlreadyInitialized();
        factory = msg.sender;
    }

    /// @notice Emits one ciphertext transmission under the writer's chosen keystream nonce.
    function append(uint64 nonce, uint8 kind, bytes calldata cipher) external {
        if (cipher.length == 0) revert EmptyCipher();
        if (cipher.length > 2048) revert CipherTooLarge(cipher.length);

        unchecked {
            ++seq;
        }

        emit Heard(seq, msg.sender, nonce, kind, cipher);
    }
}
