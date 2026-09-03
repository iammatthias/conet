import { describe, expect, test } from "bun:test";
import { HEARD_TOPIC } from "./abi";
import { JsonRpcClient } from "./rpc";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

const factory = "0x3333333333333333333333333333333333333333";
const calldata = `0x0d65e3a4${"0".repeat(24)}${"11".repeat(20)}`;

function rpcFetcher(results: unknown[], calls: RpcRequest[]): typeof fetch {
  return (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    calls.push(request);
    return Response.json({ jsonrpc: "2.0", id: request.id, result: results.shift() });
  }) as typeof fetch;
}

function bodyFetcher(body: unknown, status = 200): typeof fetch {
  return (async (_input: unknown, _init?: RequestInit) => Response.json(body, { status })) as typeof fetch;
}

describe("JSON-RPC startup reads", () => {
  test("reads the chain ID as a quantity", async () => {
    const calls: RpcRequest[] = [];
    const client = new JsonRpcClient("http://rpc.invalid", rpcFetcher(["0x14a34"], calls));

    expect(await client.chainId()).toBe(84_532n);
    expect(calls).toEqual([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }]);
  });

  test("reads latest contract code for the configured address", async () => {
    const calls: RpcRequest[] = [];
    const client = new JsonRpcClient("http://rpc.invalid", rpcFetcher(["0x60006000"], calls));

    expect(await client.getCode(factory)).toBe("0x60006000");
    expect(calls).toEqual([{
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [factory, "latest"],
    }]);
  });

  test("times out a hung RPC transport instead of waiting forever", async () => {
    const hangingFetcher = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const client = new JsonRpcClient("http://rpc.invalid", hangingFetcher, 10);

    await expect(client.blockNumber()).rejects.toThrow("RPC eth_blockNumber timed out after 10ms");
  });

  test("rejects malformed chain IDs and bytecode", async () => {
    const malformedChain = new JsonRpcClient("http://rpc.invalid", rpcFetcher(["31337"], []));
    await expect(malformedChain.chainId()).rejects.toThrow("invalid eth_chainId result");

    const malformedCode = new JsonRpcClient("http://rpc.invalid", rpcFetcher(["0x123"], []));
    await expect(malformedCode.getCode(factory)).rejects.toThrow("invalid eth_getCode result");
  });
});

describe("JSON-RPC chain reads", () => {
  test("calls a contract at the latest block and returns the raw return data", async () => {
    const calls: RpcRequest[] = [];
    const word = `0x${"0".repeat(63)}7`;
    const client = new JsonRpcClient("http://rpc.invalid", rpcFetcher([word], calls));

    expect(await client.call(factory, calldata)).toBe(word);
    expect(calls).toEqual([{
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: factory, data: calldata }, "latest"],
    }]);
  });

  test("rejects eth_call return data that is not whole hex bytes", async () => {
    for (const result of ["0x123", "7", "", null]) {
      const client = new JsonRpcClient("http://rpc.invalid", rpcFetcher([result], []));
      await expect(client.call(factory, calldata)).rejects.toThrow(/invalid eth_call result|omitted result/);
    }
  });

  test("surfaces a revert as the node's JSON-RPC error", async () => {
    const client = new JsonRpcClient(
      "http://rpc.invalid",
      bodyFetcher({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }),
    );

    await expect(client.call(factory, calldata)).rejects.toThrow("RPC 3: execution reverted");
  });

  test("encodes log filters as quantities and returns the log array", async () => {
    const calls: RpcRequest[] = [];
    const log = { address: factory, topics: [HEARD_TOPIC], data: "0x", blockNumber: "0x5", logIndex: "0x0" };
    const client = new JsonRpcClient("http://rpc.invalid", rpcFetcher([[log], "0x"], calls));

    expect(await client.getLogs({ address: factory, fromBlock: 2n, toBlock: 10n, topics: [HEARD_TOPIC, null] })).toEqual([log]);
    expect(calls[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{ address: factory, fromBlock: "0x2", toBlock: "0xa", topics: [HEARD_TOPIC, null] }],
    });
    await expect(client.getLogs({ address: factory, fromBlock: 2n, toBlock: 10n, topics: [] }))
      .rejects.toThrow("invalid eth_getLogs result");
  });

  test("fails on a non-OK HTTP status before reading a result", async () => {
    const client = new JsonRpcClient("http://rpc.invalid", bodyFetcher({ result: "0x1" }, 503));
    await expect(client.blockNumber()).rejects.toThrow("RPC HTTP 503");
  });

  test("fails when a successful response omits the result", async () => {
    const client = new JsonRpcClient("http://rpc.invalid", bodyFetcher({ jsonrpc: "2.0", id: 1 }));
    await expect(client.blockNumber()).rejects.toThrow("RPC response omitted result");
  });
});
