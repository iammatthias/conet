export const STATION_MINTED_TOPIC =
  "0x85ef9f965ffa3c76ec40074d335407047a2a04adc5e7e4981b41b26297da2631";
export const HEARD_TOPIC =
  "0x7749f8171f4c205bdb0091272211daba89e23f60f9f9842d092ead135d8b01c3";

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  removed?: boolean;
}

export interface LogFilter {
  fromBlock: number;
  toBlock: number;
  topics: string[];
  address?: string | string[];
}

export interface ChainReader {
  blockNumber(): Promise<number>;
  blockHash(blockNumber: number): Promise<string | undefined>;
  getLogs(filter: LogFilter): Promise<RpcLog[]>;
  blockLogs(blockNumber: number): Promise<RpcLog[]>;
}

export function refusesHistory(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("archive")
    || message.includes("personal token")
    || message.includes("too far")
    || message.includes("older than")
    || message.includes("block range");
}

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function quantity(value: number): string {
  return `0x${value.toString(16)}`;
}

export class Rpc implements ChainReader {
  private id = 0;

  constructor(private readonly url: string, private readonly timeoutMs = 30_000) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    this.id += 1;
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new RpcError(`${method} http ${response.status}`);
    const body = await response.json() as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new RpcError(`${method}: ${body.error.message}`);
    if (body.result === undefined) throw new RpcError(`${method} returned no result`);
    return body.result;
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_chainId", [])));
  }

  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_blockNumber", [])));
  }

  async blockHash(blockNumber: number): Promise<string | undefined> {
    const block = await this.call<{ hash: string } | null>("eth_getBlockByNumber", [quantity(blockNumber), false]);
    return block?.hash;
  }

  async getLogs(filter: LogFilter): Promise<RpcLog[]> {
    return this.call<RpcLog[]>("eth_getLogs", [{
      address: filter.address,
      fromBlock: quantity(filter.fromBlock),
      toBlock: quantity(filter.toBlock),
      topics: filter.topics,
    }]);
  }

  async blockLogs(blockNumber: number): Promise<RpcLog[]> {
    const receipts = await this.call<{ logs: RpcLog[] }[]>("eth_getBlockReceipts", [quantity(blockNumber)]);
    return receipts.flatMap((receipt) => receipt.logs);
  }
}

export function decodeStationMinted(log: RpcLog): {
  stationId: number; address: string; creator: string; blockNumber: number; logIndex: number;
} {
  if (log.topics.length < 4) throw new Error("StationMinted log is missing topics");
  return {
    stationId: Number(BigInt(log.topics[1]!)),
    address: `0x${log.topics[2]!.slice(26)}`.toLowerCase(),
    creator: `0x${log.topics[3]!.slice(26)}`.toLowerCase(),
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
  };
}

export function decodeHeard(log: RpcLog): {
  station: string; seq: number; nonce: string; writer: string; kind: number; cipher: string;
  blockNumber: number; logIndex: number; transactionHash: string;
} {
  if (log.topics.length < 3) throw new Error("Heard log is missing topics");
  const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  if (data.length < 256) throw new Error("Heard data is shorter than its header");
  if (!/^0{48}$/.test(data.slice(0, 48))) throw new Error("Heard nonce exceeds uint64");
  const nonce = data.slice(48, 64);
  const kind = Number(BigInt(`0x${data.slice(64, 128)}`));
  const offset = Number(BigInt(`0x${data.slice(128, 192)}`));
  if (offset !== 0x60) throw new Error("Heard data uses a non-canonical offset");
  const length = Number(BigInt(`0x${data.slice(192, 256)}`));
  const cipher = data.slice(256, 256 + length * 2);
  if (cipher.length !== length * 2) throw new Error("Heard cipher is truncated");
  return {
    station: log.address.toLowerCase(),
    seq: Number(BigInt(log.topics[1]!)),
    nonce,
    writer: `0x${log.topics[2]!.slice(26)}`.toLowerCase(),
    kind,
    cipher,
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
    transactionHash: log.transactionHash,
  };
}
