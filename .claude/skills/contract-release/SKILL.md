---
name: contract-release
description: Cut, re-verify, or deploy a CONET contract version. Use when touching eth/src, bumping salts, re-pinning the CREATE2 tuple, or bringing the factory up on a new chain.
---

# Contract release

The deployment is a deterministic CREATE2 tuple, and every downstream surface
pins it. `make test` enforces the mechanical parts (`abi-check`, `pins-check`,
the Foundry pin tests); this is the order of operations around them.

## Invariants

- Any byte change under `eth/src/` moves both addresses. The compiler's metadata
  hash covers source bytes, comments and whitespace included, and the creation
  code carries that hash. `forge fmt` ignores `src/` (see `eth/foundry.toml`)
  for exactly this reason. Never reformat a deployed source and never "fix" a
  comment in one; a wrong comment in a deployed contract is corrected in docs,
  or in the next version.
- The wire protocol (`conet.v3` keystream domain, frame format byte 3, the
  64-bit CSPRNG nonce, the 2048-byte cap, the base-100000 observer encoding) is
  frozen and specified once, in `web/public/skill.md`. A contract version may
  change event topics, selectors, addresses, and gas; a wire change is a new
  domain string and a new version identifier everywhere, never an edit.
- Foundry tests stay dependency-free: hand-rolled asserts, no forge-std.

## Re-verify the current pins

```sh
make pins          # derives the tuple from the sources in a local EVM
make pins-check    # every document carries the tuple from eth/script and eth/test
make abi-check     # web/public/abi/*.json match the compiled contracts
```

## Cut version N

1. Edit `eth/src/`. Bump `TARGET_SALT` and `FACTORY_SALT` in
   `eth/script/DeployConetFactory.s.sol` to `conet.target.vN` and
   `conet.factory.vN`. A new target with the old factory salt is a different
   address anyway, but the salt names the version for readers.
2. `make pins` prints the new tuple: both salts, addresses, init-code hashes, and
   runtime hashes. The factory runtime hash comes from a deployed instance because
   `target` is an immutable; hashing compiler output gives the wrong value.
3. Pin it in code, all in one commit:
   - `eth/script/DeployConetFactory.s.sol`: `TARGET_ADDRESS`, `FACTORY_ADDRESS`.
   - `eth/test/DeployConetFactory.t.sol`: `EXPECTED_FACTORY`, factory init-code
     hash, factory salt hash, factory runtime hash, target runtime hash.
   - `eth/test/ConetFactory.t.sol`: `Conet` creation-code hash.
   - If an event or function signature changed: the topic and selector pins in
     `eth/test/Conet.t.sol`, `eth/test/ConetFactory.t.sol`,
     `web/src/server/abi.ts`, and `indexer/src/chain.ts`, plus the parsers.
4. `make abi` regenerates the served ABI JSON.
5. Re-pin the documents. `make pins-check` names each missing value and where:
   `web/public/skill.md` (pin block, event layouts, vector 4 if the event
   changed, Stability), `README.md` (live deployment table and the version
   narrative), `.env.example`, `eth/README.md`, `eth/PROTOCOL.md`,
   `web/README.md`, `indexer/README.md`. Everything under `web/public/`
   describes the live deployment only: remove the retired version's coordinates
   there rather than listing them as superseded.
6. `make test`.
7. Deploy (below) and record the receipt.

## Deploy, on any chain

Unchanged source bytes land at the pinned addresses on every chain that has the
canonical CREATE2 proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C`, so
bringing an existing version up on a new chain changes coordinates, not
addresses. Before broadcasting: `cast code` on the
proxy is non-empty, `cast code` on both pinned addresses is empty, and the
deployer holds gas.

```sh
cd eth && forge script script/DeployConetFactory.s.sol:DeployConetFactory \
  --rpc-url "$STATION_RPC_URL" --private-key "$STATION_PRIVATE_KEY" --broadcast
```

Then confirm `cast keccak $(cast code $FACTORY)` equals the pinned runtime hash
and `cast call $FACTORY "target()(address)"` equals the pinned target. Public
RPCs are load-balanced and lag: an empty code hash seconds after a confirmed
deploy is a stale node, so retry before concluding anything.

Record the chainId, both tx hashes, and the factory block in `README.md`, the
chain and block in `.env.example`, and the chain and block in the `This deployment`
section of `web/public/skill.md`. The served skill and the tuner describe one
deployment: switching conet.fm to a new chain takes the old chain's Stations
off the tuner, though they stay readable through any RPC and the explorer.

Redeploy the indexer with a fresh database whenever the factory or chain
changes. The index is bound to chainId and factory and refuses a mismatch, but
a stale database on the old pair is indistinguishable from a healthy one until
the tuner shows old Stations.
