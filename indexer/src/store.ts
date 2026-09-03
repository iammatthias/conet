import { Database } from "bun:sqlite";
import { existsSync, renameSync, unlinkSync } from "node:fs";

export interface StationRow {
  stationId: number;
  address: string;
  creator: string;
  blockNumber: number;
  logIndex: number;
}

export interface TransmissionRow {
  station: string;
  seq: number;
  nonce: string;
  writer: string;
  kind: number;
  cipher: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface Checkpoint {
  blockNumber: number;
  blockHash: string;
}

export interface Deployment {
  chainId: number;
  factory: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS station (
  station_id   INTEGER PRIMARY KEY,
  address      TEXT NOT NULL UNIQUE,
  creator      TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS station_by_block ON station (block_number, log_index);

CREATE TABLE IF NOT EXISTS transmission (
  address      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  nonce        TEXT NOT NULL,
  kind         INTEGER NOT NULL,
  cipher       TEXT NOT NULL,
  writer       TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  tx_hash      TEXT NOT NULL,
  PRIMARY KEY (address, seq)
);
CREATE INDEX IF NOT EXISTS transmission_by_block ON transmission (block_number, log_index);
CREATE INDEX IF NOT EXISTS transmission_by_station ON transmission (address, block_number, log_index);

CREATE TABLE IF NOT EXISTS checkpoint (
  block_number INTEGER PRIMARY KEY,
  block_hash   TEXT NOT NULL
);
`;

const REINDEX_HINT = "delete the database and its -wal and -shm files to index from scratch";

function boundDeployment(db: Database): { chainId: string; factory: string } | "unbound" | undefined {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  if (tables.length === 0) return undefined;
  if (!tables.includes("meta")) return "unbound";
  const meta = new Map(db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta").all().map((row) => [row.key, row.value]));
  return { chainId: meta.get("chain_id") ?? "", factory: meta.get("factory") ?? "" };
}

function archiveDatabase(path: string, reason: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = `${path}.${reason}.${stamp}.archived`;
  renameSync(path, archived);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
  }
  return archived;
}

export class IndexStore {
  static open(path: string, deployment: Deployment): IndexStore {
    const probe = new Database(path, { create: true });
    const bound = boundDeployment(probe);
    probe.close();
    const factory = deployment.factory.toLowerCase();
    if (bound === "unbound" || (bound && (bound.chainId !== String(deployment.chainId) || bound.factory !== factory))) {
      const reason = bound === "unbound" ? "unbound" : `chain${bound.chainId}-${bound.factory}`;
      const flattener = new Database(path);
      flattener.exec("PRAGMA journal_mode = DELETE");
      flattener.close();
      const archived = archiveDatabase(path, reason);
      console.log(`index database was bound to ${reason.replace("chain", "chain ")}, not chain ${deployment.chainId} factory ${factory}; archived it to ${archived} and starting from scratch`);
    }
    return new IndexStore(new Database(path, { create: true }), deployment);
  }

  constructor(private readonly db: Database, deployment: Deployment) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    this.bind(deployment);
    db.exec(SCHEMA);
  }

  private bind(deployment: Deployment): void {
    const factory = deployment.factory.toLowerCase();
    const tables = this.db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((t) => t.name);

    if (tables.length === 0) {
      this.db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const insert = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      insert.run("chain_id", String(deployment.chainId));
      insert.run("factory", factory);
      insert.finalize();
      return;
    }
    if (!tables.includes("meta")) {
      throw new Error(`database predates the deployment binding; ${REINDEX_HINT}`);
    }

    const bound = new Map(
      this.db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta").all()
        .map((row) => [row.key, row.value]),
    );
    if (bound.get("chain_id") !== String(deployment.chainId) || bound.get("factory") !== factory) {
      throw new Error(
        `database is bound to chain ${bound.get("chain_id")} factory ${bound.get("factory")}, `
        + `not chain ${deployment.chainId} factory ${factory}; ${REINDEX_HINT}`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  watermark(): Checkpoint | undefined {
    return this.checkpoints()[0];
  }

  checkpoints(): Checkpoint[] {
    return this.db.query<{ block_number: number; block_hash: string }, []>(
      "SELECT block_number, block_hash FROM checkpoint ORDER BY block_number DESC",
    ).all().map((r) => ({ blockNumber: r.block_number, blockHash: r.block_hash }));
  }

  commit(stations: StationRow[], transmissions: TransmissionRow[], checkpoint: Checkpoint, retainBlocks: number): void {
    const insertStation = this.db.prepare(
      `INSERT INTO station (station_id, address, creator, block_number, log_index)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (station_id) DO NOTHING`,
    );
    const insertTransmission = this.db.prepare(
      `INSERT INTO transmission (address, seq, nonce, kind, cipher, writer, block_number, log_index, tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (address, seq) DO NOTHING`,
    );
    const insertCheckpoint = this.db.prepare(
      `INSERT INTO checkpoint (block_number, block_hash) VALUES (?, ?)
       ON CONFLICT (block_number) DO UPDATE SET block_hash = excluded.block_hash`,
    );
    const prune = this.db.prepare(
      `DELETE FROM checkpoint WHERE block_number < (
         SELECT MAX(block_number) FROM checkpoint WHERE block_number <= ?
       )`,
    );

    this.db.transaction(() => {
      for (const s of stations) {
        insertStation.run(s.stationId, s.address, s.creator, s.blockNumber, s.logIndex);
      }
      for (const t of transmissions) {
        insertTransmission.run(t.station, t.seq, t.nonce, t.kind, t.cipher, t.writer, t.blockNumber, t.logIndex, t.transactionHash);
      }
      insertCheckpoint.run(checkpoint.blockNumber, checkpoint.blockHash);
      prune.run(checkpoint.blockNumber - retainBlocks);
    })();
    for (const statement of [insertStation, insertTransmission, insertCheckpoint, prune]) statement.finalize();
  }

  rollbackTo(blockNumber: number): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM station WHERE block_number > ?", [blockNumber]);
      this.db.run("DELETE FROM transmission WHERE block_number > ?", [blockNumber]);
      this.db.run("DELETE FROM checkpoint WHERE block_number > ?", [blockNumber]);
    })();
  }

  stationAddresses(): string[] {
    return this.db.query<{ address: string }, []>("SELECT address FROM station").all().map((r) => r.address);
  }

  stationsAfter(blockNumber: number, logIndex: number, limit: number): StationRow[] {
    return this.db.query<
      { station_id: number; address: string; creator: string; block_number: number; log_index: number },
      [number, number, number, number]
    >(
      `SELECT station_id, address, creator, block_number, log_index FROM station
       WHERE block_number > ? OR (block_number = ? AND log_index > ?)
       ORDER BY block_number, log_index LIMIT ?`,
    ).all(blockNumber, blockNumber, logIndex, limit).map((r) => ({
      stationId: r.station_id, address: r.address, creator: r.creator,
      blockNumber: r.block_number, logIndex: r.log_index,
    }));
  }

  transmissionsAfter(address: string, blockNumber: number, logIndex: number, limit: number): TransmissionRow[] {
    return this.db.query<
      { address: string; seq: number; nonce: string; kind: number; cipher: string; writer: string; block_number: number; log_index: number; tx_hash: string },
      [string, number, number, number, number]
    >(
      `SELECT address, seq, nonce, kind, cipher, writer, block_number, log_index, tx_hash FROM transmission
       WHERE address = ? AND (block_number > ? OR (block_number = ? AND log_index > ?))
       ORDER BY block_number, log_index LIMIT ?`,
    ).all(address.toLowerCase(), blockNumber, blockNumber, logIndex, limit).map((r) => ({
      station: r.address, seq: r.seq, nonce: r.nonce, kind: r.kind, cipher: r.cipher, writer: r.writer,
      blockNumber: r.block_number, logIndex: r.log_index, transactionHash: r.tx_hash,
    }));
  }

  stationByAddress(address: string): StationRow | undefined {
    const r = this.db.query<
      { station_id: number; address: string; creator: string; block_number: number; log_index: number },
      [string]
    >(
      "SELECT station_id, address, creator, block_number, log_index FROM station WHERE address = ?",
    ).get(address.toLowerCase());
    if (!r) return undefined;
    return {
      stationId: r.station_id, address: r.address, creator: r.creator,
      blockNumber: r.block_number, logIndex: r.log_index,
    };
  }

  highestStationId(): number {
    const r = this.db.query<{ n: number | null }, []>("SELECT MAX(station_id) AS n FROM station").get();
    return r?.n ?? 0;
  }

  counts(): { stations: number; transmissions: number } {
    const s = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM station").get()!;
    const t = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM transmission").get()!;
    return { stations: s.n, transmissions: t.n };
  }
}
