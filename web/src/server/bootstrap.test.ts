import { describe, expect, test } from "bun:test";
import { verifyChainStartup, type StartupChainReader } from "./bootstrap";

const factoryAddress = "0x3333333333333333333333333333333333333333";
const config = { chainId: 31_337, factoryAddress };

describe("tuner chain startup verification", () => {
  test("accepts the configured chain when the factory has code", async () => {
    const calls: string[] = [];
    const chain: StartupChainReader = {
      chainId: async () => { calls.push("chainId"); return 31_337n; },
      getCode: async (address) => { calls.push(`getCode:${address}`); return "0x60006000"; },
    };

    expect(await verifyChainStartup(config, chain)).toEqual({
      chainId: 31_337n,
      factoryCodeBytes: 4,
    });
    expect(calls).toEqual(["chainId", `getCode:${factoryAddress}`]);
  });

  test("rejects the wrong chain before inspecting an address there", async () => {
    let codeReads = 0;
    const chain: StartupChainReader = {
      chainId: async () => 84_532n,
      getCode: async () => { codeReads += 1; return "0x6000"; },
    };

    await expect(verifyChainStartup(config, chain)).rejects.toThrow(
      "Configured chain ID 31337 does not match RPC chain ID 84532",
    );
    expect(codeReads).toBe(0);
  });

  test("rejects an address with no deployed contract", async () => {
    const chain: StartupChainReader = {
      chainId: async () => 31_337n,
      getCode: async () => "0x",
    };

    await expect(verifyChainStartup(config, chain)).rejects.toThrow(
      `No contract code at configured ConetFactory address ${factoryAddress} on chain 31337`,
    );
  });
});
