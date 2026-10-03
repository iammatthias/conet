import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const factory = "0x3333333333333333333333333333333333333333";

describe("server configuration", () => {
  test("requires deployment-specific factory coordinates", () => {
    expect(() => loadConfig({ STATION_FACTORY_BLOCK: "1" })).toThrow("STATION_FACTORY_ADDRESS is required");
    expect(() => loadConfig({ STATION_FACTORY_ADDRESS: factory })).toThrow("STATION_FACTORY_BLOCK is required");
  });

  test("accepts an explicitly configured factory deployment", () => {
    const config = loadConfig({
      STATION_FACTORY_ADDRESS: factory.toUpperCase().replace("0X", "0x"),
      STATION_FACTORY_BLOCK: "0",
    });

    expect(config.factoryAddress).toBe(factory);
    expect(config.factoryBlock).toBe(0n);
    expect(config.confirmationDepth).toBe(0n);
  });

  test("accepts an optional confirmation depth", () => {
    const config = loadConfig({
      STATION_FACTORY_ADDRESS: factory,
      STATION_FACTORY_BLOCK: "2",
      STATION_CONFIRMATION_DEPTH: "3",
    });
    expect(config.confirmationDepth).toBe(3n);

    expect(() => loadConfig({
      STATION_FACTORY_ADDRESS: factory,
      STATION_FACTORY_BLOCK: "2",
      STATION_CONFIRMATION_DEPTH: "-1",
    })).toThrow("STATION_CONFIRMATION_DEPTH must be an unsigned decimal integer");
  });

  test("rejects page sizes above the private tuner bound", () => {
    expect(() => loadConfig({
      STATION_FACTORY_ADDRESS: factory,
      STATION_FACTORY_BLOCK: "2",
      STATION_MAX_PAGE_SIZE: "101",
    })).toThrow("STATION_MAX_PAGE_SIZE cannot exceed 100");
  });

  test("embed origins are an allowlist of bare origins", () => {
    const base = { STATION_FACTORY_ADDRESS: factory, STATION_FACTORY_BLOCK: "2" };
    expect(loadConfig(base).embedOrigins).toEqual([]);
    expect(loadConfig({ ...base, STATION_EMBED_ORIGINS: " https://IAmMatthias.com/, http://192.0.2.10:4321 ,https://iammatthias.com" }).embedOrigins)
      .toEqual(["https://iammatthias.com", "http://192.0.2.10:4321"]);
    expect(() => loadConfig({ ...base, STATION_EMBED_ORIGINS: "https://iammatthias.com/posts" }))
      .toThrow("STATION_EMBED_ORIGINS entries must be origins with no path");
    expect(() => loadConfig({ ...base, STATION_EMBED_ORIGINS: "iammatthias.com" }))
      .toThrow("STATION_EMBED_ORIGINS entries must be origins with no path");
    expect(() => loadConfig({ ...base, STATION_EMBED_ORIGINS: "*" }))
      .toThrow("STATION_EMBED_ORIGINS entries must be origins with no path");
  });

  test("the deployment file's CONET names are accepted, and STATION names win", () => {
    const shared = loadConfig({ CONET_RPC_URL: "https://mainnet.base.org", CONET_CHAIN_ID: "8453", CONET_FACTORY_ADDRESS: factory, CONET_FACTORY_BLOCK: "50801478" });
    expect(shared.rpcUrl).toBe("https://mainnet.base.org");
    expect(shared.chainId).toBe(8453);
    expect(shared.factoryAddress).toBe(factory);
    expect(shared.factoryBlock).toBe(50801478n);
    const overridden = loadConfig({ CONET_CHAIN_ID: "8453", STATION_CHAIN_ID: "84532", CONET_FACTORY_ADDRESS: factory, CONET_FACTORY_BLOCK: "1", STATION_FACTORY_BLOCK: "2" });
    expect(overridden.chainId).toBe(84532);
    expect(overridden.factoryBlock).toBe(2n);
  });

  describe("extra chains", () => {
    const primary = { STATION_CHAIN_ID: "8453", STATION_FACTORY_ADDRESS: factory, STATION_FACTORY_BLOCK: "50801478", STATION_MAX_BLOCK_RANGE: "2000" };

    test("the primary chain is the only one when none are added", () => {
      expect(Array.from(loadConfig(primary).chains.keys())).toEqual([8453]);
    });

    test("take coordinates from the deployment list and connection details from env", () => {
      const config = loadConfig({
        ...primary,
        STATION_CONFIRMATION_DEPTH: "2",
        STATION_CHAINS: " 1, 4663 ",
        STATION_RPC_URL_1: "https://eth.example",
        STATION_INDEXER_URL_1: "http://indexer-1:3100",
        STATION_MAX_BLOCK_RANGE_1: "50",
        CONET_RPC_URL_4663: "https://robinhood.example",
        STATION_CONFIRMATION_DEPTH_4663: "0",
      });
      expect(Array.from(config.chains.keys())).toEqual([8453, 1, 4663]);
      expect(config.chains.get(1)).toEqual({
        chainId: 1,
        name: "Ethereum",
        rpcUrl: "https://eth.example",
        factoryAddress: factory,
        factoryBlock: 26113629n,
        confirmationDepth: 2n,
        maxBlockRange: 50n,
        indexerUrl: "http://indexer-1:3100",
        explorerUrl: "https://etherscan.io",
      });
      expect(config.chains.get(4663)).toMatchObject({
        rpcUrl: "https://robinhood.example",
        factoryBlock: 79297347n,
        confirmationDepth: 0n,
        maxBlockRange: 2000n,
        indexerUrl: undefined,
        explorerUrl: "https://robin.etherscan.io",
      });
      expect(config.chains.get(8453)).toMatchObject({ factoryBlock: 50801478n, rpcUrl: "http://127.0.0.1:8545" });
    });

    test("refuse a chain with no factory deployment", () => {
      expect(() => loadConfig({ ...primary, STATION_CHAINS: "10", STATION_RPC_URL_10: "https://op.example" }))
        .toThrow("STATION_CHAINS lists chain 10, which has no factory deployment");
    });

    test("refuse a chain with no RPC", () => {
      expect(() => loadConfig({ ...primary, STATION_CHAINS: "1" }))
        .toThrow("STATION_RPC_URL_1 is required for chain 1");
    });

    test("refuse the primary, a repeat, or a malformed id", () => {
      const rpc = { STATION_RPC_URL_1: "https://eth.example", STATION_RPC_URL_8453: "https://base.example" };
      expect(() => loadConfig({ ...primary, ...rpc, STATION_CHAINS: "8453" })).toThrow("STATION_CHAINS lists the primary chain 8453");
      expect(() => loadConfig({ ...primary, ...rpc, STATION_CHAINS: "1,1" })).toThrow("STATION_CHAINS lists a chain twice");
      expect(() => loadConfig({ ...primary, ...rpc, STATION_CHAINS: "eth" })).toThrow("STATION_CHAINS must be a positive decimal integer");
      expect(() => loadConfig({ ...primary, ...rpc, STATION_CHAINS: "1", STATION_MAX_BLOCK_RANGE_1: "0" }))
        .toThrow("STATION_MAX_BLOCK_RANGE_1 must be positive");
    });
  });
});
