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
});
