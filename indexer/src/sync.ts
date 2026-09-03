import {
  decodeHeard,
  decodeStationMinted,
  HEARD_TOPIC,
  refusesHistory,
  STATION_MINTED_TOPIC,
  type ChainReader,
  type LogFilter,
  type RpcLog,
} from "./chain";
import type { IndexStore, StationRow } from "./store";

export interface SyncConfig {
  factoryAddress: string;
  factoryBlock: number;
  maxBlockRange: number;
  confirmationDepth: number;
  reorgLookback: number;
  addressChunkSize: number;
}

export type SyncStatus = "caught-up" | "scanned" | "not-ready" | "discarded";

export interface SyncProgress {
  status: SyncStatus;
  scannedThrough: number;
  head: number;
  caughtUp: boolean;
}

const RANGE_FLOOR = 32;
const RECEIPT_WALK_LIMIT = 120;
const CHECKPOINT_SPAN_MULTIPLIER = 4;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export function backoffMs(failures: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

function requiresAddressFilter(error: unknown): boolean {
  const message = errorText(error);
  return message.includes("specify an address")
    || message.includes("address is required")
    || message.includes("missing address");
}

function rejectsAddressList(error: unknown): boolean {
  const message = errorText(error);
  if (!message.includes("address")) return false;
  return message.includes("too many")
    || message.includes("too large")
    || message.includes("exceed")
    || message.includes("limit")
    || message.includes("maximum");
}

export class Syncer {
  private range: number;
  private addressChunk: number;
  private knownStations = new Set<string>();
  private topicOnlyScans = true;
  private readonly checkpointRetention: number;

  constructor(
    private readonly rpc: ChainReader,
    private readonly store: IndexStore,
    private readonly config: SyncConfig,
  ) {
    this.range = config.maxBlockRange;
    this.addressChunk = config.addressChunkSize;
    this.checkpointRetention = CHECKPOINT_SPAN_MULTIPLIER * config.reorgLookback;
    this.loadStations();
  }

  private loadStations(): void {
    this.knownStations = new Set(this.store.stationAddresses());
  }

  private scannedThrough(): number {
    return this.store.watermark()?.blockNumber ?? this.config.factoryBlock - 1;
  }

  private shrink(): void {
    this.range = Math.max(RANGE_FLOOR, Math.floor(this.range / 2));
  }

  private grow(): void {
    this.range = Math.min(this.config.maxBlockRange, this.range * 2);
  }

  async step(): Promise<SyncProgress> {
    const head = await this.rpc.blockNumber();
    const safeHead = head - this.config.confirmationDepth;
    const scanned = this.scannedThrough();
    const progress = (status: SyncStatus, scannedThrough: number): SyncProgress => (
      { status, scannedThrough, head, caughtUp: scannedThrough >= safeHead }
    );
    if (safeHead <= scanned) return progress("caught-up", scanned);

    const fromBlock = scanned + 1;
    let toBlock = Math.min(safeHead, fromBlock + this.range - 1);
    let anchor = await this.rpc.blockHash(toBlock);
    if (anchor === undefined) return progress("not-ready", scanned);

    const addresses = new Set(this.knownStations);
    let stations: StationRow[];
    let heard: RpcLog[];
    try {
      const minted = await this.rpc.getLogs({
        address: this.config.factoryAddress, fromBlock, toBlock, topics: [STATION_MINTED_TOPIC],
      });
      stations = minted.filter((log) => !log.removed).map(decodeStationMinted);
      for (const s of stations) addresses.add(s.address);
      heard = await this.heardLogs({ fromBlock, toBlock, topics: [HEARD_TOPIC] }, addresses);
    } catch (error) {
      if (!refusesHistory(error)) {
        this.shrink();
        throw error;
      }
      toBlock = Math.min(toBlock, fromBlock + RECEIPT_WALK_LIMIT - 1);
      anchor = await this.rpc.blockHash(toBlock);
      if (anchor === undefined) return progress("not-ready", scanned);
      ({ stations, heard } = await this.walkReceipts(fromBlock, toBlock, addresses));
    }
    if (await this.rpc.blockHash(toBlock) !== anchor) return progress("discarded", scanned);

    const transmissions = heard
      .filter((log) => !log.removed && addresses.has(log.address.toLowerCase()))
      .map(decodeHeard);
    this.store.commit(stations, transmissions, { blockNumber: toBlock, blockHash: anchor }, this.checkpointRetention);
    this.knownStations = addresses;
    this.grow();
    return progress("scanned", toBlock);
  }

  private async walkReceipts(fromBlock: number, toBlock: number, addresses: Set<string>): Promise<{ stations: StationRow[]; heard: RpcLog[] }> {
    const stations: StationRow[] = [];
    const heard: RpcLog[] = [];
    for (let block = fromBlock; block <= toBlock; block += 1) {
      for (const log of await this.rpc.blockLogs(block)) {
        if (log.removed) continue;
        const address = log.address.toLowerCase();
        if (address === this.config.factoryAddress && log.topics[0] === STATION_MINTED_TOPIC) {
          const station = decodeStationMinted(log);
          stations.push(station);
          addresses.add(station.address);
        } else if (log.topics[0] === HEARD_TOPIC && addresses.has(address)) {
          heard.push(log);
        }
      }
    }
    return { stations, heard };
  }

  private async heardLogs(window: LogFilter, addresses: Set<string>): Promise<RpcLog[]> {
    if (addresses.size === 0) return [];
    if (this.topicOnlyScans) {
      try {
        return await this.rpc.getLogs(window);
      } catch (error) {
        if (!requiresAddressFilter(error)) throw error;
        this.topicOnlyScans = false;
      }
    }
    return this.chunkedHeardLogs(window, [...addresses]);
  }

  private async chunkedHeardLogs(window: LogFilter, addresses: string[]): Promise<RpcLog[]> {
    try {
      const logs: RpcLog[] = [];
      for (let i = 0; i < addresses.length; i += this.addressChunk) {
        logs.push(...await this.rpc.getLogs({ ...window, address: addresses.slice(i, i + this.addressChunk) }));
      }
      return logs;
    } catch (error) {
      if (!rejectsAddressList(error) || this.addressChunk === 1) throw error;
      this.addressChunk = Math.floor(this.addressChunk / 2);
      return this.chunkedHeardLogs(window, addresses);
    }
  }

  async reconcile(): Promise<number | undefined> {
    const watermark = this.store.watermark();
    if (!watermark) return undefined;
    const live = await this.rpc.blockHash(watermark.blockNumber);
    if (live === undefined || live === watermark.blockHash) return undefined;

    for (const checkpoint of this.store.checkpoints()) {
      if (checkpoint.blockNumber === watermark.blockNumber) continue;
      if (await this.rpc.blockHash(checkpoint.blockNumber) === checkpoint.blockHash) {
        return this.rollbackTo(checkpoint.blockNumber);
      }
    }
    return this.rollbackTo(this.config.factoryBlock - 1);
  }

  private rollbackTo(blockNumber: number): number {
    this.store.rollbackTo(blockNumber);
    this.loadStations();
    return blockNumber;
  }
}
