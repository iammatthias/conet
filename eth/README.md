# CONET — Ethereum

Foundry project for CONET's two contracts. `Conet` is the immutable Station: an
append-only log whose `Heard` events carry ciphertext. `ConetFactory` mints
EIP-1167 clones of one `Conet` target and answers provenance for them. Both are
deployed through the canonical CREATE2 proxy under fixed salts, so their
addresses follow from the bytes and nothing else.

The wire protocol the Stations carry, `conet.v3`, is specified once, in the
served skill at [`../web/public/skill.md`](../web/public/skill.md): frame,
keystream, nonce, reader rules, conformance vectors, and the security
boundary. Nothing in this directory restates it. [`PROTOCOL.md`](PROTOCOL.md)
maps that protocol onto the operating patterns of historical numbers stations
and records what each contract version changed.

Run Foundry commands from `eth/`. Run `make` targets from the repository root.

## Layout

- `src/` — the deployed sources. Every byte is part of the address, because the
  compiler's metadata hash covers comments and whitespace, so `forge fmt`
  ignores this directory and the sources are never edited in place. A change is
  a new version; the `contract-release` project skill is the checklist.
- `script/DeployConetFactory.s.sol` — deploys the target and then the factory
  through the proxy. It verifies the proxy's runtime, the predicted addresses,
  and any code already at them before sending anything, and returns the
  existing verified deployment rather than deploying twice.
  `script/Pins.s.sol` derives the whole tuple in a local EVM (`make pins`).
- `test/` — dependency-free Foundry tests with hand-rolled asserts: the log's
  behaviour and boundaries, every contract error, clone and provenance
  semantics, and the deployment pins. Fuzz tests run 1,000 cases by default.

## Requirements and test

Foundry (`anvil`, `forge`, `cast`). `forge test --offline` here runs the
contracts alone; `make test` at the repository root also checks the served ABI
against the compiled contracts, checks every document for the deployment pins,
and runs the web suite.

## Deployment

The canonical v3 tuple, pinned in the deploy script and tests and reproduced by
`make pins`:

| Coordinate | Value |
| --- | --- |
| Proxy | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| Target salt | `keccak256("conet.target.v3")` |
| Target address | `0x3560E9576a9E2D3D073BbB759bF379531C5Ca3d3` |
| Target init-code hash | `0x97915f6ede15da587e5d71827404652109db682ff865f3ec6626e2386e9fbd77` |
| Target runtime hash | `0xfb176cda17cba1bdbb54c7df65e0323ceb0d1ed01b998713ca606ad2ae0afe1b` |
| Factory salt | `keccak256("conet.factory.v3")` |
| Factory address | `0xB084351e5Fd70d318a2264Bc8af63C4575Db8844` |
| Factory init-code hash | `0x8bc323a2d2159dcc66435f2fe92a25554e687543f1004116ca4ed1620c7615ed` |
| Factory runtime hash | `0x80b1eb5c1f812d2e9c7881570c9a9a704ba18c867d6de54e2a4f6bce07518ab2` |

The factory's init code is its creation code followed by the target address as a
32-byte word, so the factory address only reproduces once the target address is
fixed. Hashing the compiler's `deployedBytecode` for the factory does not give
the runtime hash, because `target` is an immutable the compiler leaves zeroed;
hash the deployed code.

CREATE2 is deterministic over the proxy address, the salt, and the exact init
code. A chain without the verified proxy, a chain that cannot execute the
pinned bytecode, or a build with different compiler settings is not compatible
with this rendezvous. The same address on another chain shares no state, so
every deployment record carries chainId and the factory's deployment block.
Base mainnet coordinates are in the repository README and `.env.example`.

## Local Anvil workflow

Anvil installs the canonical CREATE2 proxy by default; do not pass
`--disable-default-create2-deployer`.

```sh
anvil
```

In another terminal, with one of the funded development keys Anvil printed
(localhost only; never fund a public deployment with them):

```sh
export STATION_RPC_URL=http://127.0.0.1:8545
export STATION_PRIVATE_KEY=0x...
export STATION_CHAIN_ID=31337

forge script script/DeployConetFactory.s.sol:DeployConetFactory \
  --rpc-url "$STATION_RPC_URL" \
  --private-key "$STATION_PRIVATE_KEY" \
  --broadcast
```

The factory lands at the pinned address regardless of broadcaster or nonce.
Configure the tuner with it and the block it was deployed in:

```sh
export STATION_FACTORY=0xB084351e5Fd70d318a2264Bc8af63C4575Db8844
export STATION_FACTORY_BLOCK=1
```

The block is `1` only for a fresh local chain. On any other chain, record the
actual deployment block; if the script finds an existing verified factory it
sends no transaction and cannot tell you when the first deployment happened.

## Minting

`mint()` takes no arguments; the chain never sees a Station's material or any
commitment to it.

```sh
cast send "$STATION_FACTORY" "mint()" \
  --rpc-url "$STATION_RPC_URL" \
  --private-key "$STATION_PRIVATE_KEY"
```

Read the `StationMinted` log emitted by the factory address itself, since a
receipt can carry more than one log with that topic: the Station is the last
20 bytes of the station topic, the factory-local id is the first topic, and the
receipt's block is the Station's mint block. Record those beside the material,
privately. That record is the only binding between a Station and its
capability, and `*.otp` is ignored by git. Everything from here on, framing,
keystream, nonce, receipts, replay, and validation, is the skill's.
