import { describe, expect, test } from "bun:test";
import { ChainMismatch, verifyChainStartup, verifyChainStartupPatiently, type StartupChainReader } from "./bootstrap";

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

describe("patient startup verification", () => {
  const coordinates = { chainId: 8453, factoryAddress: "0x1111111111111111111111111111111111111111" };
  const flaky = (failures: number, chainId = 8453n) => {
    let calls = 0;
    return {
      calls: () => calls,
      chainId: async () => {
        calls += 1;
        if (calls <= failures) throw new Error("RPC HTTP 429");
        return chainId;
      },
      getCode: async () => "0x6001",
    };
  };
  const instant = { sleep: async () => undefined };

  test("retries a rate-limited RPC until it answers", async () => {
    const chain = flaky(3);
    const verified = await verifyChainStartupPatiently(coordinates, chain, instant);
    expect(verified.chainId).toBe(8453n);
    expect(chain.calls()).toBe(4);
  });

  test("gives up after the last attempt", async () => {
    const chain = flaky(10);
    await expect(verifyChainStartupPatiently(coordinates, chain, { ...instant, attempts: 3 })).rejects.toThrow("429");
    expect(chain.calls()).toBe(3);
  });

  test("never retries a chain that answers with the wrong id", async () => {
    const chain = flaky(0, 1n);
    await expect(verifyChainStartupPatiently(coordinates, chain, instant)).rejects.toBeInstanceOf(ChainMismatch);
    expect(chain.calls()).toBe(1);
  });
});
