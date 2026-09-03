import type { ServerConfig } from "./config";

export interface StartupChainReader {
  chainId(): Promise<bigint>;
  getCode(address: string): Promise<string>;
}

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
    throw new Error(
      `Configured chain ID ${expectedChainId} does not match RPC chain ID ${actualChainId}`,
    );
  }

  const factoryCode = await chain.getCode(config.factoryAddress);
  if (factoryCode === "0x") {
    throw new Error(
      `No contract code at configured ConetFactory address ${config.factoryAddress} on chain ${actualChainId}`,
    );
  }

  return {
    chainId: actualChainId,
    factoryCodeBytes: (factoryCode.length - 2) / 2,
  };
}
