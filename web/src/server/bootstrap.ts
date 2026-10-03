import type { ServerConfig } from "./config";

export interface StartupChainReader {
  chainId(): Promise<bigint>;
  getCode(address: string): Promise<string>;
}

export class ChainMismatch extends Error {}

export interface StartupVerification {
  chainId: bigint;
  factoryCodeBytes: number;
}

export async function verifyChainStartup(
  config: Pick<ServerConfig, "chainId" | "factoryAddress">,
  chain: StartupChainReader,
): Promise<StartupVerification> {
  const actualChainId = await chain.chainId();
  const expectedChainId = BigInt(config.chainId);
  if (actualChainId !== expectedChainId) {
    throw new ChainMismatch(
      `Configured chain ID ${expectedChainId} does not match RPC chain ID ${actualChainId}`,
    );
  }

  const factoryCode = await chain.getCode(config.factoryAddress);
  if (factoryCode === "0x") {
    throw new ChainMismatch(
      `No contract code at configured ConetFactory address ${config.factoryAddress} on chain ${actualChainId}`,
    );
  }

  return {
    chainId: actualChainId,
    factoryCodeBytes: (factoryCode.length - 2) / 2,
  };
}

export async function verifyChainStartupPatiently(
  config: Pick<ServerConfig, "chainId" | "factoryAddress">,
  chain: StartupChainReader,
  { attempts = 6, firstDelayMs = 1000, sleep = (ms: number) => Bun.sleep(ms) }: { attempts?: number; firstDelayMs?: number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<StartupVerification> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await verifyChainStartup(config, chain);
    } catch (error) {
      if (error instanceof ChainMismatch || attempt >= attempts) throw error;
      console.warn(`chain ${config.chainId} startup check failed (${(error as Error).message}); retrying`);
      await sleep(firstDelayMs * 2 ** (attempt - 1));
    }
  }
}
