import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HEARD_TOPIC, STATION_MINTED_TOPIC, type ChainReader, type LogFilter, type RpcLog } from "./chain";
import { IndexStore } from "./store";
import { backoffMs, Syncer, type SyncConfig } from "./sync";

const FACTORY = `0x${"f".repeat(40)}`;
const CREATOR = `0x${"c".repeat(40)}`;
const VECTOR_4_DATA = "0x"
  + "0000000000000000000000000000000000000000000000000000000064e4c0e6"
  + "0000000000000000000000000000000000000000000000000000000000000001"
  + "0000000000000000000000000000000000000000000000000000000000000060"
  + "000000000000000000000000000000000000000000000000000000000000001c"
  + "3b1ae56f9bfd9e9cf3fff4477847ed4c295b3b2d22d44ee9bc6dd1fc00000000";

function word(value: number | string): string {
  const hex = typeof value === "number" ? value.toString(16) : value.slice(2);
  return `0x${hex.padStart(64, "0")}`;
}

function quantity(value: number): string {
  return `0x${value.toString(16)}`;
}

function stationAddress(stationId: number): string {
  return `0x${stationId.toString(16).padStart(40, "0")}`;
}

function minted(stationId: number, block: number): RpcLog {
  return {
    address: FACTORY,
    topics: [STATION_MINTED_TOPIC, word(stationId), word(stationAddress(stationId)), word(CREATOR)],
    data: "0x",
    blockNumber: quantity(block),
    logIndex: "0x0",
    transactionHash: word(block),
  };
}

function heard(stationId: number, seq: number, block: number): RpcLog {
  return {
    address: stationAddress(stationId),
    topics: [HEARD_TOPIC, word(seq), word(CREATOR)],
    data: VECTOR_4_DATA,
    blockNumber: quantity(block),
    logIndex: "0x1",
    transactionHash: word(block),
  };
}

class ScriptedChain implements ChainReader {
  head = 0;
  logs: RpcLog[] = [];
  readonly hashes = new Map<number, string>();
  readonly filters: LogFilter[] = [];
  topicOnlyRefusal?: string;
  historyWindow = Number.POSITIVE_INFINITY;
  maxAddresses = Number.POSITIVE_INFINITY;
  onGetLogs?: () => void;
  receiptBlocks: number[] = [];

  hash(block: number, tag = "h"): string {
    const hash = `0x${tag}${block}`;
    this.hashes.set(block, hash);
    return hash;
  }

  async blockNumber(): Promise<number> {
    return this.head;
  }

  async blockHash(blockNumber: number): Promise<string | undefined> {
    return this.hashes.get(blockNumber);
  }

  async getLogs(filter: LogFilter): Promise<RpcLog[]> {
    this.filters.push(filter);
    this.onGetLogs?.();
    if (filter.address === undefined && this.topicOnlyRefusal) throw new Error(this.topicOnlyRefusal);
    if (filter.fromBlock < this.head - this.historyWindow) throw new Error("eth_getLogs: Archive requests require a personal token");
    const addresses = filter.address === undefined ? undefined : [filter.address].flat().map((a) => a.toLowerCase());
    if (addresses && addresses.length > this.maxAddresses) throw new Error("too many addresses in filter");
    return this.logs.filter((log) => {
      const block = Number(log.blockNumber);
      return block >= filter.fromBlock && block <= filter.toBlock
        && log.topics[0] === filter.topics[0]
        && (addresses === undefined || addresses.includes(log.address.toLowerCase()));
    });
  }

  async blockLogs(blockNumber: number): Promise<RpcLog[]> {
    this.receiptBlocks.push(blockNumber);
    return this.logs.filter((log) => Number(log.blockNumber) === blockNumber);
  }

  heardAddressLists(): Array<string[] | undefined> {
    return this.filters
      .filter((f) => f.topics[0] === HEARD_TOPIC)
      .map((f) => (Array.isArray(f.address) ? f.address : undefined));
  }
}

function harness(overrides: Partial<SyncConfig> = {}) {
  const chain = new ScriptedChain();
  const store = new IndexStore(new Database(":memory:"), { chainId: 1, factory: FACTORY });
  const config: SyncConfig = {
    factoryAddress: FACTORY,
    factoryBlock: 100,
    maxBlockRange: 50,
    confirmationDepth: 0,
    reorgLookback: 8,
    addressChunkSize: 8,
    ...overrides,
  };
  return { chain, store, syncer: new Syncer(chain, store, config) };
}

async function threeWindows() {
  const h = harness();
  h.chain.head = 249;
  for (const block of [149, 199, 249]) h.chain.hash(block);
  h.chain.logs = [minted(1, 120), heard(1, 1, 130), minted(2, 210), heard(1, 2, 220), heard(2, 1, 230)];
  for (let i = 0; i < 3; i += 1) await h.syncer.step();
  expect(h.store.watermark()).toEqual({ blockNumber: 249, blockHash: "0xh249" });
  expect(h.store.counts()).toEqual({ stations: 2, transmissions: 3 });
  return h;
}

describe("history the node refuses", () => {
  test("a window behind the node's log horizon is walked by block receipts on the same node", async () => {
    const { chain, store, syncer } = harness();
    chain.head = 249;
    chain.historyWindow = 100;
    for (const block of [149, 199, 249]) chain.hash(block);
    chain.logs = [minted(1, 120), heard(1, 1, 130), minted(2, 210), heard(1, 2, 220), heard(2, 1, 230)];

    for (let i = 0; i < 3; i += 1) expect((await syncer.step()).status).toBe("scanned");

    expect(store.watermark()).toEqual({ blockNumber: 249, blockHash: "0xh249" });
    expect(store.counts()).toEqual({ stations: 2, transmissions: 3 });
    expect(chain.receiptBlocks[0]).toBe(100);
    expect(chain.receiptBlocks.at(-1)).toBe(149);
    expect(chain.receiptBlocks).toHaveLength(50);
    expect(chain.filters.filter((f) => f.fromBlock === 150)).not.toHaveLength(0);
    expect((await syncer.step()).status).toBe("caught-up");
  });

  test("a refusal that is not about history still narrows the window and surfaces", async () => {
    const { chain, syncer } = harness();
    chain.head = 249;
    chain.hash(149);
    chain.onGetLogs = () => { throw new Error("eth_getLogs http 429"); };
    await expect(syncer.step()).rejects.toThrow("429");
    expect(chain.receiptBlocks).toHaveLength(0);
  });
});

describe("hash-anchored windows", () => {
  test("a window whose end block the node has not served is neither committed nor narrowed", async () => {
    const { chain, store, syncer } = harness();
    chain.head = 400;

    expect((await syncer.step()).status).toBe("not-ready");
    expect(store.watermark()).toBeUndefined();
    expect(chain.filters).toHaveLength(0);

    chain.hash(149);
    expect((await syncer.step()).status).toBe("scanned");
    expect(store.watermark()).toEqual({ blockNumber: 149, blockHash: "0xh149" });
  });

  test("a block hash that changes during the scan discards the window", async () => {
    const { chain, store, syncer } = harness();
    chain.head = 149;
    chain.hash(149, "before");
    chain.logs = [minted(1, 120), heard(1, 1, 130)];
    chain.onGetLogs = () => {
      chain.hash(149, "after");
      chain.onGetLogs = undefined;
    };

    expect((await syncer.step()).status).toBe("discarded");
    expect(store.watermark()).toBeUndefined();
    expect(store.counts()).toEqual({ stations: 0, transmissions: 0 });

    expect((await syncer.step()).status).toBe("scanned");
    expect(store.watermark()).toEqual({ blockNumber: 149, blockHash: "0xafter149" });
    expect(store.counts()).toEqual({ stations: 1, transmissions: 1 });
  });
});

describe("reorgs", () => {
  test("a watermark mismatch rolls back to the newest checkpoint still on the chain and forgets Stations minted after it", async () => {
    const { chain, store, syncer } = await threeWindows();
    chain.hash(249, "fork");
    chain.logs = [minted(1, 120), heard(1, 1, 130), heard(1, 2, 225), heard(2, 1, 230)];

    expect(await syncer.reconcile()).toBe(199);
    expect(store.watermark()).toEqual({ blockNumber: 199, blockHash: "0xh199" });
    expect(store.counts()).toEqual({ stations: 1, transmissions: 1 });

    expect((await syncer.step()).status).toBe("scanned");
    expect(store.transmissionsAfter(stationAddress(1), 0, -1, 10).map((t) => t.blockNumber)).toEqual([130, 225]);
    expect(store.transmissionsAfter(stationAddress(2), 0, -1, 10)).toEqual([]);
    expect(await syncer.reconcile()).toBeUndefined();
  });

  test("with no checkpoint left on the chain the index restarts from the factory block", async () => {
    const { chain, store, syncer } = await threeWindows();
    for (const block of [149, 199, 249]) chain.hash(block, "fork");

    expect(await syncer.reconcile()).toBe(99);
    expect(store.watermark()).toBeUndefined();
    expect(store.counts()).toEqual({ stations: 0, transmissions: 0 });
    expect((await syncer.step()).scannedThrough).toBe(149);
  });

  test("a node that has not served the watermark block yet is lagging, not forked", async () => {
    const { chain, store, syncer } = await threeWindows();
    chain.hashes.delete(249);

    expect(await syncer.reconcile()).toBeUndefined();
    expect(store.counts()).toEqual({ stations: 2, transmissions: 3 });
  });
});

describe("provider limits", () => {
  test("a provider that refuses topic-only scans is asked by address from then on", async () => {
    const { chain, store, syncer } = harness();
    chain.topicOnlyRefusal = "eth_getLogs requires you to specify an address";
    chain.head = 149;
    chain.hash(149);
    chain.logs = [minted(1, 120), heard(1, 1, 130)];

    await syncer.step();
    expect(chain.heardAddressLists()).toEqual([undefined, [stationAddress(1)]]);
    expect(store.counts()).toEqual({ stations: 1, transmissions: 1 });

    chain.head = 199;
    chain.hash(199);
    await syncer.step();
    expect(chain.heardAddressLists()).toEqual([undefined, [stationAddress(1)], [stationAddress(1)]]);
  });

  test("an address list the provider rejects is halved until accepted, without narrowing the block window", async () => {
    const { chain, store, syncer } = harness({ addressChunkSize: 8 });
    chain.topicOnlyRefusal = "specify an address";
    chain.maxAddresses = 3;
    chain.head = 149;
    chain.hash(149);
    for (let id = 1; id <= 8; id += 1) chain.logs.push(minted(id, 100 + id), heard(id, 1, 120 + id));

    expect((await syncer.step()).status).toBe("scanned");
    expect(chain.heardAddressLists().map((a) => a?.length)).toEqual([undefined, 8, 4, 2, 2, 2, 2]);
    expect(store.counts()).toEqual({ stations: 8, transmissions: 8 });

    chain.head = 199;
    chain.hash(199);
    expect((await syncer.step()).scannedThrough).toBe(199);
  });
});

describe("error backoff", () => {
  test("doubles with jitter inside the upper half and caps at a minute", () => {
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(1, () => 1)).toBe(1_000);
    expect(backoffMs(4, () => 0)).toBe(4_000);
    expect(backoffMs(20, () => 1)).toBe(60_000);
  });
});
