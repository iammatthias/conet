import { Rpc } from "./chain";
import { IndexStore } from "./store";
import { backoffMs, Syncer, type SyncConfig, type SyncProgress } from "./sync";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(raw: string, name: string, min: number): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer of at least ${min}`);
  }
  return value;
}

function requiredInteger(name: string, min = 1): number {
  return integer(required(name), name, min);
}

function optionalInteger(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  return raw === undefined ? fallback : integer(raw, name, min);
}

const config: SyncConfig = {
  factoryAddress: required("CONET_FACTORY_ADDRESS").toLowerCase(),
  factoryBlock: requiredInteger("CONET_FACTORY_BLOCK"),
  maxBlockRange: optionalInteger("CONET_MAX_BLOCK_RANGE", 2_000),
  confirmationDepth: optionalInteger("CONET_CONFIRMATION_DEPTH", 2, 0),
  reorgLookback: optionalInteger("CONET_REORG_LOOKBACK", 32),
  addressChunkSize: optionalInteger("CONET_ADDRESS_CHUNK", 100),
};
const chainId = requiredInteger("CONET_CHAIN_ID");
const rpcUrl = required("CONET_RPC_URL");
const databasePath = process.env.CONET_DB_PATH ?? "./conet-index.sqlite";
const port = optionalInteger("CONET_INDEXER_PORT", 3100);
const idleMs = optionalInteger("CONET_IDLE_MS", 4_000);
const maxPageSize = optionalInteger("CONET_MAX_PAGE_SIZE", 1_000);
const maxLagBlocks = optionalInteger("CONET_MAX_LAG_BLOCKS", 50, 0);

const rpc = new Rpc(rpcUrl);
const liveChainId = await rpc.chainId();
if (liveChainId !== chainId) {
  throw new Error(`CONET_RPC_URL serves chain ${liveChainId}, not CONET_CHAIN_ID ${chainId}`);
}

const store = IndexStore.open(databasePath, { chainId, factory: config.factoryAddress });
const syncer = new Syncer(rpc, store, config);

let lastProgress: SyncProgress = {
  status: "not-ready",
  scannedThrough: store.watermark()?.blockNumber ?? config.factoryBlock - 1,
  head: 0,
  caughtUp: false,
};
let caughtUpOnce = false;
let lastError: string | undefined;
let running = true;

async function loop(): Promise<void> {
  let failures = 0;
  while (running) {
    try {
      const rolledBackTo = await syncer.reconcile();
      if (rolledBackTo !== undefined) console.log(`reorg detected; rolled the index back to block ${rolledBackTo}`);
      lastProgress = await syncer.step();
      lastError = undefined;
      failures = 0;
      if (lastProgress.caughtUp) caughtUpOnce = true;
      if (lastProgress.status === "discarded") console.log("chain moved under a scan window; discarded it");
      if (lastProgress.status !== "scanned") await Bun.sleep(idleMs);
    } catch (error) {
      failures += 1;
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`sync error: ${lastError}`);
      await Bun.sleep(backoffMs(failures));
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function cursorFrom(raw: string | null): { block: number; logIndex: number } {
  if (!raw) return { block: 0, logIndex: -1 };
  const [b, i] = raw.split(":");
  const block = Number(b);
  const logIndex = Number(i);
  if (!Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(logIndex)) {
    throw new Error("cursor must be block:logIndex");
  }
  return { block, logIndex };
}

function pageLimit(raw: string | null): number {
  return Math.min(raw === null ? 100 : integer(raw, "limit", 1), maxPageSize);
}

const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    if (url.pathname === "/health") {
      const behind = Math.max(0, lastProgress.head - lastProgress.scannedThrough);
      const ok = lastError === undefined && caughtUpOnce && behind <= maxLagBlocks;
      return json({
        ok,
        caughtUp: lastProgress.caughtUp,
        scannedThrough: lastProgress.scannedThrough,
        head: lastProgress.head,
        behind,
        ...store.counts(),
        error: lastError,
      }, ok ? 200 : 503);
    }

    try {
      if (url.pathname === "/stations") {
        const cursor = cursorFrom(url.searchParams.get("cursor"));
        const rows = store.stationsAfter(cursor.block, cursor.logIndex, pageLimit(url.searchParams.get("limit")));
        const last = rows.at(-1);
        return json({
          stations: rows,
          cursor: last ? `${last.blockNumber}:${last.logIndex}` : url.searchParams.get("cursor") ?? "0:-1",
          caughtUp: lastProgress.caughtUp,
          scannedThrough: lastProgress.scannedThrough,
          highestStationId: store.highestStationId(),
        });
      }

      const transmissions = /^\/stations\/(0x[0-9a-fA-F]{40})\/transmissions$/.exec(url.pathname);
      if (transmissions) {
        const address = transmissions[1]!.toLowerCase();
        const known = store.stationByAddress(address);
        if (!known) return json({ error: "station not indexed" }, 404);
        const cursor = cursorFrom(url.searchParams.get("cursor"));
        const rows = store.transmissionsAfter(address, cursor.block, cursor.logIndex, pageLimit(url.searchParams.get("limit")));
        const last = rows.at(-1);
        return json({
          station: known,
          transmissions: rows,
          cursor: last ? `${last.blockNumber}:${last.logIndex}` : url.searchParams.get("cursor") ?? "0:-1",
          caughtUp: lastProgress.caughtUp,
          scannedThrough: lastProgress.scannedThrough,
        });
      }
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`conet indexer listening on http://localhost:${server.port}`);
console.log(`  chain ${chainId}, factory ${config.factoryAddress} from block ${config.factoryBlock}`);
console.log(`  database ${databasePath} (WAL)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
    server.stop();
    store.close();
    process.exit(0);
  });
}

await loop();
