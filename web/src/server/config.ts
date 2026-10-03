import { fileURLToPath } from "node:url";
import { DEPLOYMENTS } from "./deployments";

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  factoryAddress: string;
  factoryBlock: bigint;
  confirmationDepth: bigint;
  maxBlockRange: bigint;
  indexerUrl?: string;
  explorerUrl?: string;
}

export interface ServerConfig {
  rpcUrl: string;
  chainId: number;
  factoryAddress: string;
  factoryBlock: bigint;
  confirmationDepth: bigint;
  maxBlockRange: bigint;
  maxPageSize: number;
  indexPageSize: number;
  port: number;
  distDir: string;
  indexerUrl?: string;
  explorerUrl?: string;
  embedOrigins: readonly string[];
  chains: ReadonlyMap<number, ChainConfig>;
}

function unsignedBigInt(value: string | undefined, fallback: bigint, name: string): bigint {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned decimal integer`);
  return BigInt(value);
}

function requiredUnsignedBigInt(value: string | undefined, name: string): bigint {
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned decimal integer`);
  return BigInt(value);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} is out of range`);
  return parsed;
}

const KNOWN_EXPLORERS: Readonly<Record<number, string>> = Object.freeze({
  1: "https://etherscan.io",
  8453: "https://basescan.org",
  4663: "https://robin.etherscan.io",
  84532: "https://sepolia.basescan.org",
  11155111: "https://sepolia.etherscan.io",
});

const KNOWN_CHAIN_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "Ethereum",
  8453: "Base",
  4663: "Robinhood Chain",
  84532: "Base Sepolia",
  11155111: "Sepolia",
  31337: "Anvil",
});

export function chainName(chainId: number): string {
  return KNOWN_CHAIN_NAMES[chainId] ?? `chain ${chainId}`;
}

function explorer(value: string | undefined, chainId: number): string | undefined {
  const configured = value?.replace(/\/+$/, "");
  if (configured) {
    if (!/^https:\/\/[a-z0-9.-]+(\/[\w./-]*)?$/i.test(configured)) {
      throw new Error("STATION_EXPLORER_URL must be an https origin");
    }
    return configured;
  }
  return KNOWN_EXPLORERS[chainId];
}

function embedOrigins(value: string | undefined): readonly string[] {
  const origins = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\/+$/, ""))
    .filter((entry) => entry !== "");
  for (const origin of origins) {
    if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(origin)) {
      throw new Error("STATION_EMBED_ORIGINS entries must be origins with no path");
    }
  }
  return Object.freeze(Array.from(new Set(origins)));
}

function address(value: string | undefined): string {
  if (!value) throw new Error("STATION_FACTORY_ADDRESS is required");
  const candidate = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(candidate)) throw new Error("STATION_FACTORY_ADDRESS must be an Ethereum address");
  return candidate;
}

function blockRange(value: string | undefined, fallback: bigint, name: string): bigint {
  const range = unsignedBigInt(value, fallback, name);
  if (range < 1n) throw new Error(`${name} must be positive`);
  return range;
}

function extraChainIds(value: string | undefined, primaryChainId: number): number[] {
  const ids = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => positiveInteger(entry, 0, "STATION_CHAINS"));
  for (const id of ids) {
    if (id === primaryChainId) throw new Error(`STATION_CHAINS lists the primary chain ${id}`);
  }
  if (new Set(ids).size !== ids.length) throw new Error("STATION_CHAINS lists a chain twice");
  return ids;
}

function extraChain(
  env: Record<string, string | undefined>,
  chainId: number,
  primary: ChainConfig,
): ChainConfig {
  const deployment = DEPLOYMENTS.find((candidate) => candidate.chainId === chainId);
  if (!deployment) throw new Error(`STATION_CHAINS lists chain ${chainId}, which has no factory deployment`);
  const rpcUrl = env[`STATION_RPC_URL_${chainId}`] || env[`CONET_RPC_URL_${chainId}`];
  if (!rpcUrl) throw new Error(`STATION_RPC_URL_${chainId} is required for chain ${chainId}`);
  return {
    chainId,
    name: deployment.name,
    rpcUrl,
    factoryAddress: primary.factoryAddress,
    factoryBlock: BigInt(deployment.factoryBlock),
    confirmationDepth: unsignedBigInt(
      env[`STATION_CONFIRMATION_DEPTH_${chainId}`],
      primary.confirmationDepth,
      `STATION_CONFIRMATION_DEPTH_${chainId}`,
    ),
    maxBlockRange: blockRange(env[`STATION_MAX_BLOCK_RANGE_${chainId}`], primary.maxBlockRange, `STATION_MAX_BLOCK_RANGE_${chainId}`),
    indexerUrl: env[`STATION_INDEXER_URL_${chainId}`] || undefined,
    explorerUrl: deployment.explorer,
  };
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): ServerConfig {
  const maxBlockRange = blockRange(env.STATION_MAX_BLOCK_RANGE, 2_000n, "STATION_MAX_BLOCK_RANGE");
  const maxPageSize = positiveInteger(env.STATION_MAX_PAGE_SIZE, 100, "STATION_MAX_PAGE_SIZE");
  if (maxPageSize > 100) throw new Error("STATION_MAX_PAGE_SIZE cannot exceed 100");
  const indexPageSize = positiveInteger(env.STATION_INDEX_PAGE_SIZE, 1_000, "STATION_INDEX_PAGE_SIZE");
  if (indexPageSize > 2_000) throw new Error("STATION_INDEX_PAGE_SIZE cannot exceed 2000");

  const chainId = positiveInteger(env.STATION_CHAIN_ID ?? env.CONET_CHAIN_ID, 31_337, "STATION_CHAIN_ID");

  const primary: ChainConfig = {
    chainId,
    name: chainName(chainId),
    rpcUrl: env.STATION_RPC_URL ?? env.CONET_RPC_URL ?? "http://127.0.0.1:8545",
    factoryAddress: address(env.STATION_FACTORY_ADDRESS ?? env.CONET_FACTORY_ADDRESS),
    factoryBlock: requiredUnsignedBigInt(env.STATION_FACTORY_BLOCK ?? env.CONET_FACTORY_BLOCK, "STATION_FACTORY_BLOCK"),
    confirmationDepth: unsignedBigInt(env.STATION_CONFIRMATION_DEPTH, 0n, "STATION_CONFIRMATION_DEPTH"),
    maxBlockRange,
    indexerUrl: env.STATION_INDEXER_URL || undefined,
    explorerUrl: explorer(env.STATION_EXPLORER_URL, chainId),
  };
  const chains = new Map<number, ChainConfig>([[chainId, primary]]);
  for (const extraId of extraChainIds(env.STATION_CHAINS ?? env.CONET_CHAINS, chainId)) {
    chains.set(extraId, extraChain(env, extraId, primary));
  }

  return {
    ...primary,
    maxPageSize,
    indexPageSize,
    port: positiveInteger(env.PORT, 3000, "PORT"),
    distDir: env.STATION_DIST_DIR ?? fileURLToPath(new URL("../../dist", import.meta.url)),
    embedOrigins: embedOrigins(env.STATION_EMBED_ORIGINS),
    chains,
  };
}
