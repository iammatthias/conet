import type { RpcLog } from "./abi";

export interface LogFilter {
  address: string;
  fromBlock: bigint;
  toBlock: bigint;
  topics: Array<string | null>;
}

export interface ChainReader {
  blockNumber(): Promise<bigint>;
  getLogs(filter: LogFilter): Promise<RpcLog[]>;
  call(to: string, data: string): Promise<string>;
}

function hexQuantity(value: bigint): string {
  if (value < 0n) throw new Error("negative block number");
  return `0x${value.toString(16)}`;
}

export class JsonRpcClient implements ChainReader {
  #id = 0;

  constructor(
    readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    try {
      const response = await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { code?: number; message?: string } };
      if (body.error) throw new Error(`RPC ${body.error.code ?? "error"}: ${body.error.message ?? "unknown error"}`);
      if (body.result === undefined) throw new Error("RPC response omitted result");
      return body.result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(`RPC ${method} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }

  async blockNumber(): Promise<bigint> {
    const value = await this.request<string>("eth_blockNumber", []);
    if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error("invalid eth_blockNumber result");
    return BigInt(value);
  }

  async chainId(): Promise<bigint> {
    const value = await this.request<string>("eth_chainId", []);
    if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error("invalid eth_chainId result");
    return BigInt(value);
  }

  async getCode(address: string): Promise<string> {
    const code = await this.request<string>("eth_getCode", [address, "latest"]);
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error("invalid eth_getCode result");
    return code;
  }

  async getLogs(filter: LogFilter): Promise<RpcLog[]> {
    const logs = await this.request<RpcLog[]>("eth_getLogs", [
      {
        address: filter.address,
        fromBlock: hexQuantity(filter.fromBlock),
        toBlock: hexQuantity(filter.toBlock),
        topics: filter.topics,
      },
    ]);
    if (!Array.isArray(logs)) throw new Error("invalid eth_getLogs result");
    return logs;
  }

  async call(to: string, data: string): Promise<string> {
    const result = await this.request<string>("eth_call", [{ to, data }, "latest"]);
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new Error("invalid eth_call result");
    return result;
  }
}
