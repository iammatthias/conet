import type { Heard, StationMinted } from "./abi";
import type { Cursor, Page } from "./paging";

export interface IndexSource {
  stations(cursor: Cursor, limit: number): Promise<Page<StationMinted> | undefined>;
  transmissions(station: string, cursor: Cursor, limit: number): Promise<Page<Heard> | undefined>;
  station(address: string): Promise<StationMinted | undefined>;
}

const REQUEST_TIMEOUT_MS = 2_000;
const COOLDOWN_MS = 15_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{16}$/;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const CIPHER = /^(?:[0-9a-fA-F]{2}){1,2048}$/;
const CURSOR = /^(\d+):(-1|\d+)$/;

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Fields : undefined;
}

function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function matching(value: unknown, expected: RegExp): string | undefined {
  return typeof value === "string" && expected.test(value) ? value : undefined;
}

function stationRecord(value: unknown): StationMinted | undefined {
  const row = fields(value);
  if (!row) return undefined;
  const stationId = count(row.stationId);
  const station = matching(row.address, ADDRESS);
  const creator = matching(row.creator, ADDRESS);
  const blockNumber = count(row.blockNumber);
  const logIndex = count(row.logIndex);
  if (!stationId || !station || !creator || blockNumber === undefined || logIndex === undefined) return undefined;
  return {
    stationId: BigInt(stationId),
    station,
    creator,
    blockNumber: BigInt(blockNumber),
    logIndex: BigInt(logIndex),
  };
}

function transmissionRecord(value: unknown): Heard | undefined {
  const row = fields(value);
  if (!row) return undefined;
  const seq = count(row.seq);
  const nonce = matching(row.nonce, NONCE);
  const writer = matching(row.writer, ADDRESS);
  const kind = count(row.kind, 0xff);
  const cipher = matching(row.cipher, CIPHER);
  const blockNumber = count(row.blockNumber);
  const logIndex = count(row.logIndex);
  const transactionHash = matching(row.transactionHash, TRANSACTION_HASH);
  if (
    !seq || !nonce || !writer || kind === undefined || !cipher
    || blockNumber === undefined || logIndex === undefined || !transactionHash
  ) {
    return undefined;
  }
  return {
    seq: BigInt(seq),
    nonce: BigInt(`0x${nonce}`),
    writer,
    kind,
    cipher: cipher.toLowerCase(),
    blockNumber: BigInt(blockNumber),
    logIndex: BigInt(logIndex),
    transactionHash,
  };
}

function cursorField(value: unknown): Cursor | undefined {
  const match = typeof value === "string" ? CURSOR.exec(value) : null;
  return match ? { block: BigInt(match[1]), logIndex: BigInt(match[2]) } : undefined;
}

function records<T>(value: unknown, decode: (row: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: T[] = [];
  for (const row of value) {
    const record = decode(row);
    if (!record) return undefined;
    decoded.push(record);
  }
  return decoded;
}

function nextCursor(rows: number, limit: number, reported: Cursor, scannedThrough: bigint): Cursor {
  return rows < limit ? { block: scannedThrough + 1n, logIndex: -1n } : reported;
}

function indexedPage<T>(
  body: unknown,
  key: "stations" | "transmissions",
  decode: (row: unknown) => T | undefined,
  limit: number,
): Page<T> | undefined {
  const answer = fields(body);
  if (!answer) return undefined;
  const values = records(answer[key], decode);
  const scannedThrough = count(answer.scannedThrough);
  const reported = cursorField(answer.cursor);
  const highestStationId = answer.highestStationId === undefined ? undefined : count(answer.highestStationId);
  if (!values || scannedThrough === undefined || !reported) return undefined;
  if (answer.highestStationId !== undefined && highestStationId === undefined) return undefined;
  const head = BigInt(scannedThrough);
  return {
    values,
    cursor: nextCursor(values.length, limit, reported, head),
    head,
    highestStationId: highestStationId === undefined ? undefined : BigInt(highestStationId),
  };
}

function coveringCursor<T>(page: Page<T> | undefined, cursor: Cursor): Page<T> | undefined {
  return page && page.head >= cursor.block ? page : undefined;
}

export function createIndexSource(baseUrl: string): IndexSource {
  const origin = baseUrl.replace(/\/+$/, "");
  let unhealthyUntil = 0;

  function unhealthy(): undefined {
    unhealthyUntil = Date.now() + COOLDOWN_MS;
    return undefined;
  }

  async function body(path: string): Promise<unknown> {
    if (Date.now() < unhealthyUntil) return undefined;
    try {
      const response = await fetch(`${origin}${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (response.status === 404) return undefined;
      if (!response.ok) return unhealthy();
      return await response.json();
    } catch {
      return unhealthy();
    }
  }

  async function answer<T>(path: string, decode: (body: unknown) => T | undefined): Promise<T | undefined> {
    const received = await body(path);
    if (received === undefined) return undefined;
    return decode(received) ?? unhealthy();
  }

  return {
    async stations(cursor, limit) {
      const page = await answer(
        `/stations?limit=${limit}&cursor=${cursor.block}:${cursor.logIndex}`,
        (received) => indexedPage(received, "stations", stationRecord, limit),
      );
      return coveringCursor(page, cursor);
    },

    async transmissions(station, cursor, limit) {
      const page = await answer(
        `/stations/${station}/transmissions?limit=${limit}&cursor=${cursor.block}:${cursor.logIndex}`,
        (received) => indexedPage(received, "transmissions", transmissionRecord, limit),
      );
      return coveringCursor(page, cursor);
    },

    async station(address) {
      return answer(
        `/stations/${address}/transmissions?limit=1`,
        (received) => stationRecord(fields(received)?.station),
      );
    },
  };
}
