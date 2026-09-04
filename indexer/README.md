# CONET indexer

A read-only index of one `ConetFactory` deployment. It backfills `StationMinted`
and `Heard` events into SQLite in WAL mode, tails the chain head, and serves the
tuner. The tuner treats it as a cache: when the index is unreachable or behind,
the tuner falls back to Ethereum JSON-RPC.

This is observer plumbing, exactly like the tuner. It is not an agent API, it
holds no capability material, and it never decrypts. Agents use the contract ABI
and JSON-RPC directly.

## Running

```sh
cd indexer
bun install --frozen-lockfile
CONET_RPC_URL=https://mainnet.base.org \
CONET_CHAIN_ID=8453 \
CONET_FACTORY_ADDRESS=0xB084351e5Fd70d318a2264Bc8af63C4575Db8844 \
CONET_FACTORY_BLOCK=50801478 \
CONET_DB_PATH=./conet-index.sqlite \
bun run start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONET_RPC_URL` | required | Ethereum JSON-RPC endpoint |
| `CONET_CHAIN_ID` | required | Chain the factory lives on; checked against `eth_chainId` at startup and bound into the database |
| `CONET_FACTORY_ADDRESS` | required | Factory to index; bound into the database |
| `CONET_FACTORY_BLOCK` | required | Deployment block, the scan floor |
| `CONET_DB_PATH` | `./conet-index.sqlite` | Database path; WAL files sit beside it |
| `CONET_INDEXER_PORT` | `3100` | Listen port |
| `CONET_MAX_BLOCK_RANGE` | `2000` | Largest scan window; halves on RPC error, recovers on success |
| `CONET_CONFIRMATION_DEPTH` | `2` | Blocks held back from head; zero is allowed |
| `CONET_REORG_LOOKBACK` | `32` | Checkpoints are kept across at least four times this many blocks; a fork deeper than that restarts the index from the factory block |
| `CONET_MAX_LAG_BLOCKS` | `50` | Furthest the index may trail head before `/health` answers 503 |
| `CONET_IDLE_MS` | `4000` | Poll interval once caught up |
| `CONET_MAX_PAGE_SIZE` | `1000` | Largest page a read route will return |
| `CONET_ADDRESS_CHUNK` | `100` | Starting number of addresses per request when the provider demands an address filter; halves whenever the provider rejects the list |

`bun run typecheck` and `bun test` cover the server; `src/main.ts` is the wiring.

## Routes

- `GET /health` — `{ ok, caughtUp, scannedThrough, head, behind, stations,
  transmissions, error }`. Status 200 while the index is serving current data;
  503 with the same body when the last sync errored, when the index has not
  caught up since the process started, or when it trails head by more than
  `CONET_MAX_LAG_BLOCKS`. A fresh backfill therefore reports unhealthy until it
  lands, which is the intended signal; compose surfaces it and does not restart
  on it.
- `GET /stations?cursor=block:logIndex&limit=n`
- `GET /stations/0x…/transmissions?cursor=block:logIndex&limit=n`

## Operational notes

### One database, one deployment

On first open the database records the chain id and factory address it is
indexing; every later open compares them and refuses to start on a mismatch,
as it does for a database written before the binding existed. Two registries
are never merged. When the factory changes — a new contract version deploys at
a new address — stop the indexer, delete the database together with its `-wal`
and `-shm` files, and start it against the new address; the backfill is the
whole recovery. Startup also checks `eth_chainId` against `CONET_CHAIN_ID`
before the first scan and exits non-zero if the endpoint serves another chain.

### Hash-anchored windows

Every scan window is anchored to the hash of its last block, fetched before the
logs and again after them. If the node does not have that block yet, which a
lagging replica behind a load balancer will do briefly, nothing is scanned and
the window is not narrowed; the loop idles and asks again. If the hash differs
after the scan, the chain moved underneath the window: it is discarded and
rescanned. Rows and the window's checkpoint land in one transaction, so a crash,
a redeploy, or an hour offline all resume identically, and no window is ever
recorded without its hash. Catching up is the normal path, not a recovery path.

### Checkpoints and reorgs

Each committed window leaves a checkpoint of its block number and hash. They are
pruned to span at least four times `CONET_REORG_LOOKBACK` blocks; the newest
checkpoint at or below that span survives, so wide backfill windows always leave
more than one. Before each pass the newest checkpoint is compared against the
live chain. A rewritten chain usually keeps the same heights, so height alone
never detects it; the hash does. On a mismatch the indexer walks its checkpoints
newest-first, fetches each block's live hash, and rolls back to the newest one
that still matches: rows above it are deleted and the set of known Stations is
rebuilt from what survived, so a Station minted on the abandoned branch is
forgotten until its mint is seen again. If no checkpoint matches, the index
restarts from the factory block. A node that does not serve the watermark block
at all is treated as lagging rather than forked; once it catches up, the hash
decides.

### Providers

Requests carry a browser-shaped `User-Agent`: some providers and edge proxies
reject default runtime agents outright.

Providers disagree about `eth_getLogs` in ways that decide this service's shape.
`Heard` events are scanned by topic across every Station at once where that is
allowed, which costs one request per block window no matter how many Stations
exist. Some providers refuse an address-less query outright, so the first refusal
switches the syncer permanently to address-filtered requests in chunks — correct
everywhere, one request per window on a capable provider, and a bounded number on
a restrictive one. A chunk the provider rejects as too large, recognised from its
error message, is halved and retried inside the same window, so the block range
is not narrowed for a limit it did not hit. Scan windows themselves shrink on
other RPC failures and grow back on success, so a provider tightening its limits
degrades throughput instead of stalling the index. Both paths are exercised
against live providers: some require the address filter and reject large
address lists, while others accept topic-only scans.

Sync errors back off exponentially with jitter, from about a second up to a
minute, and the backoff resets on the next successful pass.

Rebuilding from scratch costs one full chain scan and no coordination, so the
database needs no backup story beyond "delete it and restart."

## Deployment

`compose.yaml` at the repository root runs the indexer and the tuner together.
The indexer publishes no port and is reached over the compose network as
`http://indexer:3100`; only the tuner publishes one, bound to `${BIND_IP}` so it
never listens on every interface. Copy `.env.example` to `.env` and fill it in;
nothing in it is secret. Changing `CONET_FACTORY_ADDRESS` there means deleting
`./data/conet.sqlite*` first, as above.

The database lives on a bind mount at `./data`. WAL writes `-wal` and `-shm`
files beside the database, so the **directory** must be writable by the container
user, not just the file. The image runs as the `bun` user from the base image
rather than root.
