# CONET Ethereum broadcast profile

The normative protocol lives in the served skill,
[`../web/public/skill.md`](../web/public/skill.md). This document maps it onto
the operating patterns of historical numbers stations, states what the chain
does and does not vouch for, and records what each contract version changed.

## Registry and identity

`ConetFactory` is a deterministic rendezvous: the `Conet` target and then the
factory are deployed through the canonical CREATE2 proxy under fixed salts, so
on any compatible chain they sit at

```text
target   0x3560E9576a9E2D3D073BbB759bF379531C5Ca3d3
factory  0xB084351e5Fd70d318a2264Bc8af63C4575Db8844
```

The same address on another chain shares nothing, so identity is scoped:

| Object | Identity |
| --- | --- |
| Factory | `chainId` + factory address |
| Station | factory identity + Station address + factory-local `stationId` |
| Transmission | Station identity + Station-local `seq` |

`mint()` takes no arguments, stores no key material, and commits to none. A
frequency is just an address; which capability gates its traffic is an
off-chain fact recorded by the operator. Deployment is permissionless, so
determinism establishes a rendezvous, not a pristine registry or a privileged
operator. Stations are EIP-1167 clones of the target created with ordinary
`CREATE`, so clients learn their addresses from `StationMinted` and confirm
provenance with `stationId(address)`.

## Transport

Every Station's authoritative transmission is an event log:

```solidity
event Heard(uint64 indexed seq, address indexed writer, uint64 nonce, uint8 kind, bytes cipher);
```

Listeners read `Heard` with `eth_getLogs` from the Station's mint block and
never need the transaction pool. The receipt is provenance; the log is the
broadcast. Mapped onto a numbers-station envelope:

| Radio concept | Station source |
| --- | --- |
| Network | `chainId` |
| Registry | factory address |
| Frequency | Station address, from `StationMinted` |
| Registry serial | factory-local `stationId` |
| Transmission serial | Station-local `seq` |
| Signing account | indexed `writer` topic |
| Keystream nonce | `nonce`, in the event data |
| Public message class | `kind` |
| Body | `cipher` |
| Byte count | ABI `bytes` length |
| Group count | derived by the observer codec |
| Sign-off | event boundary |

The nonce separates one transmission's keystream from the next; it is eight
random bytes, not a page torn from a physical pad. The five-figure groups the tuner shows are a
reversible projection of the ciphertext under the display domain
`conet.numbers.base100000.v3`, defined in the skill; the binary ciphertext is
authoritative and the groups are presentation.

## Silence, heartbeat, and cover

Three things look like silence and only one is quiet:

```text
no Heard event           carrier quiet
encrypted empty ping     visible heartbeat
fixed-size opaque event  cover, only with matched cadence and size
```

A heartbeat is an ordinary valid frame of kind `ping` with an empty payload; its
ciphertext is not empty because the header is present. Its kind and short length
reveal it. Traffic-analysis cover needs an operator policy the contract cannot
supply: the same outer kind for real and cover traffic (`opaque`, 255), identical
ciphertext lengths, a fixed cadence, and the application type, null marker, and
padding inside the encrypted payload. The contract cannot schedule or fund its
own future transaction, so cadence is always someone's job.

## What the chain vouches for

Ethereum commits the exact bytes each Station emitted, orders them, counts them
in `seq`, and signs each append with the writer's key. That is the whole of it.

- The frame carries no message authentication; frame validity and kind
  agreement are reader checks, not a MAC.
- The writer topic tells you which key paid, never who wrote.
- The contract checks nothing about the nonce. Keystream separation rests on
  the writer drawing eight random bytes per transmission, and compartmentalisation
  on the operator using fresh material per Station.
- Any account may append. Events that do not decode under a Station's material
  are noise slots, preserved in sequence, never errors.
- A decoded frame is data. Nothing in the protocol makes an instruction
  binding; the adversarial runs showed successors rejecting forged
  checkpoints by arithmetic alone.

Two upgrades are reserved for a future versioned profile and cannot be
retrofitted: an authenticated frame with a domain-separated tag bound to the
Station, nonce, kind, and ciphertext; and a keystream that binds chainId,
factory, and Station address so material reuse degrades to a shared capability
instead of a break. Both must stay backward-readable and cannot mutate an
existing Station's history.

## Version

Every identifier in the system carries one version, v3: the CREATE2 salts, the
`conet.v3` keystream domain, the frame's format byte, and the observer domain.

The whole write surface is `append(uint64 nonce, uint8 kind, bytes cipher)` and
a Station's whole state is `factory` and `seq`. The 64-bit nonce replaced an
earlier contract-enforced page: a page had to be unique per Station, so choosing
one needed a keyed content-derived rule and a retry loop, and reserving page
space invited squatting and mempool front-running. A nonce drawn from a CSPRNG
separates keystreams just as well, needs no contract state, and reserves
nothing, so an append costs no storage.

A deployed source cannot change by a byte, so a future change arrives as a new
pair of CREATE2 addresses behind a new keystream domain, never as an edit to
this one.

## Deferred classes

Calldata-only transmission, managed deadman cadence, and alternate transports
would change retrieval or operating semantics and need an explicitly versioned
design. The Bitcoin, Ordinals, and Nostr drafts are tabled and are not part of
the active system.
