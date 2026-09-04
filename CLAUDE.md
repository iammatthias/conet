# CLAUDE.md

CONET is a public Ethereum number station: immutable contracts emit append-only
ciphertext events, and a Bun/Vite/HTMX tuner renders every event as five-figure
groups. There is no client library or CLI:
agents implement their own tooling from the served skill and the ABIs. Decoding
requires off-chain OTP material and never happens here or in the tuner.

## Layout

- `eth/` — Foundry contracts (`Conet`, `ConetFactory`), tests, the deterministic
  CREATE2 deploy script, and `PROTOCOL.md`, the radio mapping around the wire
  protocol. The wire protocol itself is specified once, in the served skill.
- `web/` — public tuner. Server code in `src/server/` is tested; `src/receiver.ts`
  is the browser receiver, mounted by `src/main.ts` on the page and by
  `src/embed.ts` as the `<conet-tuner>` element served at `/embed.js`. `/_tuner/*` routes are private presentation plumbing.
  `public/skill.md` is the canonical agent-facing protocol spec, served at
  `/skill.md` with a conformance vector; the tuner footer carries the agent
  hand-off prompt.

## Commands

- `make test` — ABI drift check, deployment-pin check, Foundry (`--offline`),
  web checks.
- `make lint` — web typecheck. `make fmt-check` for Solidity format (`src/` is
  excluded: reformatting a deployed source moves its address).
- `make abi` regenerates `web/public/abi/*.json` from the compiled contracts;
  `make pins` derives the CREATE2 tuple from the sources; `make pins-check`
  verifies every document carries it. `make abi-check` and `make pins-check`
  run inside `make test`.
- Web only: `cd web && bun run check` (typecheck + tests + build).
- Project skills: `contract-release` (cutting or re-verifying a contract
  version) and `served-skill` (editing `web/public/skill.md`).
- Local chain workflow (Anvil, env vars, deploy) is in `eth/README.md`; tuner
  configuration is in `web/README.md`.

## Naming

The product, contracts, and protocol domains are CONET (`Conet`, `ConetFactory`,
versioned `conet.factory.vN` salts, `conet.v3` keystream domain,
`conet.numbers.base100000.v3` display domain). "Station" survives as the generic
noun and in `StationMinted`, `Heard` topics, and `STATION_*` env vars. Do not
"fix" these names; event topics, the conformance vector, and ABI constants pin
them.

## Hard rules

- Follow `CODING_STANDARDS.md`: no comments (typed, self-describing code
  instead) and no tautological tests.

- OTP bytes never go onchain, into the tuner, into logs, or into git
  (`*.otp` is ignored). The chain carries no commitment to the material either:
  `mint()` is argumentless, and the Station↔material binding is each operator's
  own private record.
- The contract ABI + Ethereum JSON-RPC is the agent API. The tuner is a human
  observer; never add agent endpoints to it.
- Protocol constants (the v3 frame layout, 2048-byte cipher cap, base-100000
  codec, keystream derivation) are frozen. Changes require an explicit new version,
  not an edit.
- Any change to contract source or compiler settings moves the deterministic
  CREATE2 addresses, and "source" means bytes: the metadata hash covers comments
  and whitespace, so never reformat or annotate `eth/src/`. A new version
  follows the `contract-release` skill: re-derive with `make pins`, pin the
  script and tests together, `make abi`, re-pin docs until `make pins-check`
  passes.
- Every version identifier reads v3: contracts, salts, `conet.v3` keystream
  domain, frame format byte, observer domain. v3 replaced the contract-enforced
  page with a 64-bit random nonce.
- Everything conet.fm serves describes the live Base mainnet deployment only:
  no testnet coordinates, no superseded factories, no `conet.v0`. Retiring a
  version means removing its coordinates from `web/public/`, never listing them
  there as superseded.
- Foundry tests are dependency-free by design (hand-rolled asserts, no
  forge-std); keep it that way.
