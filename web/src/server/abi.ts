export const STATION_MINTED_TOPIC =
  "0x85ef9f965ffa3c76ec40074d335407047a2a04adc5e7e4981b41b26297da2631";
export const HEARD_TOPIC =
  "0x7749f8171f4c205bdb0091272211daba89e23f60f9f9842d092ead135d8b01c3";

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash?: string;
  logIndex: string;
  removed?: boolean;
}

export interface StationMinted {
  stationId: bigint;
  station: string;
  creator: string;
  blockNumber: bigint;
  logIndex: bigint;
}

export interface Heard {
  seq: bigint;
  nonce: bigint;
  writer: string;
  kind: number;
  cipher: string;
  blockNumber: bigint;
  logIndex: bigint;
  transactionHash?: string;
}

function bytes(value: unknown, byteLength: number, label: string): string {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${byteLength * 2}}$`).test(value)) {
    throw new Error(`${label} must be exactly ${byteLength} bytes`);
  }
  return value.slice(2).toLowerCase();
}

function dynamicBytes(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be an even-length hexadecimal value`);
  }
  return value.slice(2).toLowerCase();
}

function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`${label} is not a canonical RPC quantity`);
  }
  return BigInt(value);
}

function wordUint(topic: unknown, bits: number, label: string): bigint {
  const raw = bytes(topic, 32, label);
  const leadingNibbles = 64 - bits / 4;
  if (!/^0*$/.test(raw.slice(0, leadingNibbles))) throw new Error(`${label} exceeds uint${bits}`);
  return BigInt(`0x${raw}`);
}

function indexedAddress(topic: unknown, label: string): string {
  const raw = bytes(topic, 32, label);
  if (!/^0{24}$/.test(raw.slice(0, 24))) throw new Error(`${label} has non-zero ABI padding`);
  return `0x${raw.slice(24)}`;
}

function normalizedLog(log: RpcLog): { blockNumber: bigint; logIndex: bigint } {
  if (log.removed) throw new Error("removed logs are not canonical Station history");
  bytes(log.address, 20, "log address");
  return {
    blockNumber: quantity(log.blockNumber, "blockNumber"),
    logIndex: quantity(log.logIndex, "logIndex"),
  };
}

export function parseStationMinted(log: RpcLog): StationMinted {
  const position = normalizedLog(log);
  if (!Array.isArray(log.topics) || log.topics.length !== 4) {
    throw new Error("StationMinted must contain exactly four topics");
  }
  if (log.topics[0]?.toLowerCase() !== STATION_MINTED_TOPIC) {
    throw new Error("unexpected StationMinted signature");
  }
  bytes(log.data, 0, "StationMinted data");

  return {
    stationId: wordUint(log.topics[1], 64, "stationId"),
    station: indexedAddress(log.topics[2], "station"),
    creator: indexedAddress(log.topics[3], "creator"),
    ...position,
  };
}

export function parseHeard(log: RpcLog): Heard {
  const position = normalizedLog(log);
  if (!Array.isArray(log.topics) || log.topics.length !== 3) {
    throw new Error("Heard must contain exactly three topics");
  }
  if (log.topics[0]?.toLowerCase() !== HEARD_TOPIC) throw new Error("unexpected Heard signature");

  const data = dynamicBytes(log.data, "Heard data");
  if (data.length < 256 || data.length % 64 !== 0) throw new Error("malformed Heard event data");
  const nonceWord = data.slice(0, 64);
  if (!/^0{48}$/.test(nonceWord.slice(0, 48))) throw new Error("nonce exceeds uint64");
  const nonce = BigInt(`0x${nonceWord}`);
  const kindWord = data.slice(64, 128);
  if (!/^0{62}$/.test(kindWord.slice(0, 62))) throw new Error("kind exceeds uint8");
  const kind = Number.parseInt(kindWord.slice(62), 16);
  if (BigInt(`0x${data.slice(128, 192)}`) !== 96n) throw new Error("non-canonical Heard ABI offset");
  const length = BigInt(`0x${data.slice(192, 256)}`);
  if (length < 1n || length > 2_048n) throw new Error("cipher length is outside Station bounds");
  const paddedLength = ((Number(length) + 31) >> 5) << 5;
  if (data.length !== 256 + paddedLength * 2) throw new Error("Heard ABI length mismatch");
  const payload = data.slice(256, 256 + Number(length) * 2);
  const padding = data.slice(256 + Number(length) * 2);
  if (!/^0*$/.test(padding)) throw new Error("non-zero Heard ABI padding");

  const seq = wordUint(log.topics[1], 64, "seq");
  if (seq === 0n) throw new Error("Station sequences begin at one");
  return {
    seq,
    nonce,
    writer: indexedAddress(log.topics[2], "writer"),
    kind,
    cipher: payload,
    transactionHash: log.transactionHash,
    ...position,
  };
}

export function topicUint(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw new Error("topic integer is out of range");
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function topicAddress(value: string): string {
  const raw = bytes(value, 20, "address");
  return `0x${raw.padStart(64, "0")}`;
}

export const STATION_ID_SELECTOR = "0x0d65e3a4";

export function stationIdCalldata(station: string): string {
  return `${STATION_ID_SELECTOR}${topicAddress(station).slice(2)}`;
}

export function parseStationId(result: string): bigint {
  return wordUint(result, 64, "stationId result");
}
