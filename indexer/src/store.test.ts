import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexStore, type StationRow, type TransmissionRow } from "./store";

const DEPLOYMENT = { chainId: 84532, factory: `0x${"a".repeat(40)}` };

function fresh(): IndexStore {
  return new IndexStore(new Database(":memory:"), DEPLOYMENT);
}

function station(stationId: number, blockNumber: number): StationRow {
  return { stationId, address: `0x${stationId.toString(16).padStart(40, "0")}`, creator: "0xc", blockNumber, logIndex: 0 };
}

function transmission(station: StationRow, seq: number, blockNumber: number, logIndex = 0): TransmissionRow {
  return {
    station: station.address, seq, nonce: seq.toString(16).padStart(16, "0"), kind: 1, cipher: "aa", writer: "0xw",
    blockNumber, logIndex, transactionHash: `0x${blockNumber}:${logIndex}`,
  };
}

describe("deployment binding", () => {
  test("a database serves the deployment it was opened for and refuses any other", () => {
    const db = new Database(":memory:");
    new IndexStore(db, DEPLOYMENT);

    expect(() => new IndexStore(db, { ...DEPLOYMENT, factory: `0x${"b".repeat(40)}` }))
      .toThrow(/bound to chain 84532 factory 0xa+, not chain 84532 factory 0xb+/);
    expect(() => new IndexStore(db, { ...DEPLOYMENT, chainId: 8453 })).toThrow(/bound to chain 84532/);
    expect(() => new IndexStore(db, { ...DEPLOYMENT, factory: DEPLOYMENT.factory.toUpperCase().replace("0X", "0x") }))
      .not.toThrow();
  });

  test("opening a file bound to another deployment archives it and starts fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "conet-index-"));
    const path = join(dir, "conet.sqlite");
    try {
      const sepolia = IndexStore.open(path, DEPLOYMENT);
      const early = station(1, 50);
      sepolia.commit([early], [transmission(early, 1, 60)], { blockNumber: 70, blockHash: "0x70" }, 1_000);
      sepolia.close();

      const mainnet = IndexStore.open(path, { ...DEPLOYMENT, chainId: 8453 });
      expect(mainnet.watermark()).toBeUndefined();
      expect(mainnet.counts().stations).toBe(0);
      mainnet.close();

      const archived = readdirSync(dir).filter((name) => name.endsWith(".archived"));
      expect(archived).toHaveLength(1);
      expect(archived[0]).toContain("chain84532-");
      expect(readdirSync(dir).some((name) => name.includes(".archived-"))).toBe(false);
      const kept = new Database(join(dir, archived[0]));
      expect(kept.query<{ n: number }, []>("SELECT count(*) AS n FROM station").get()?.n).toBe(1);
      kept.close();
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a database that predates the binding is rejected rather than adopted", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE watermark (id INTEGER PRIMARY KEY, scanned_through INTEGER NOT NULL)");
    expect(() => new IndexStore(db, DEPLOYMENT)).toThrow(/predates the deployment binding/);
  });
});

describe("rollback", () => {
  test("deletes rows above the floor and resumes from the surviving checkpoint", () => {
    const store = fresh();
    const early = station(1, 50);
    const late = station(2, 80);
    store.commit([early], [transmission(early, 1, 60)], { blockNumber: 70, blockHash: "0x70" }, 1_000);
    store.commit([late], [transmission(early, 2, 90), transmission(late, 1, 100)], { blockNumber: 100, blockHash: "0x100" }, 1_000);

    store.rollbackTo(70);

    expect(store.counts()).toEqual({ stations: 1, transmissions: 1 });
    expect(store.stationByAddress(late.address)).toBeUndefined();
    expect(store.stationAddresses()).toEqual([early.address]);
    expect(store.watermark()).toEqual({ blockNumber: 70, blockHash: "0x70" });

    store.rollbackTo(49);

    expect(store.counts()).toEqual({ stations: 0, transmissions: 0 });
    expect(store.watermark()).toBeUndefined();
  });
});

describe("checkpoints", () => {
  test("keeps every checkpoint inside the retention span plus the newest one at or below it", () => {
    const store = fresh();
    for (const block of [100, 110, 120, 130, 140, 150]) {
      store.commit([], [], { blockNumber: block, blockHash: `0x${block}` }, 30);
    }
    expect(store.checkpoints().map((c) => c.blockNumber)).toEqual([150, 140, 130, 120]);
  });

  test("never prunes below one checkpoint when windows are wider than the span", () => {
    const store = fresh();
    store.commit([], [], { blockNumber: 100, blockHash: "0x100" }, 128);
    store.commit([], [], { blockNumber: 2100, blockHash: "0x2100" }, 128);
    expect(store.checkpoints().map((c) => c.blockNumber)).toEqual([2100, 100]);
  });
});

describe("reads", () => {
  test("re-committing a scanned range changes nothing", () => {
    const store = fresh();
    const s = station(1, 50);
    for (let i = 0; i < 3; i += 1) {
      store.commit([s], [transmission(s, 1, 60)], { blockNumber: 100, blockHash: "0x100" }, 1_000);
    }
    expect(store.counts()).toEqual({ stations: 1, transmissions: 1 });
    expect(store.checkpoints()).toHaveLength(1);
  });

  test("pages transmissions by block order within one Station", () => {
    const store = fresh();
    const s = station(1, 1);
    store.commit([s], [
      transmission(s, 1, 10, 2),
      transmission(s, 2, 10, 5),
      transmission(s, 3, 11, 0),
    ], { blockNumber: 20, blockHash: "0x20" }, 1_000);

    expect(store.transmissionsAfter(s.address, 10, 2, 10).map((t) => t.seq)).toEqual([2, 3]);
    expect(store.transmissionsAfter(s.address, 0, -1, 2).map((t) => t.seq)).toEqual([1, 2]);
  });
});
