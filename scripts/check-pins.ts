import { DEPLOYMENTS } from "../web/src/server/deployments";

const root = new URL("../", import.meta.url);
const read = (path: string) => Bun.file(new URL(path, root)).text();

function capture(source: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(source);
  if (!match?.[1]) throw new Error(`could not read ${label}`);
  return match[1];
}

const deployScript = await read("eth/script/DeployConetFactory.s.sol");
const deployTest = await read("eth/test/DeployConetFactory.t.sol");
const factoryTest = await read("eth/test/ConetFactory.t.sol");
const envExample = await read(".env.example");

const pins = {
  factoryAddress: capture(deployScript, /FACTORY_ADDRESS = (0x[0-9a-fA-F]{40});/, "FACTORY_ADDRESS"),
  targetAddress: capture(deployScript, /TARGET_ADDRESS = (0x[0-9a-fA-F]{40});/, "TARGET_ADDRESS"),
  factorySalt: capture(deployScript, /FACTORY_SALT = keccak256\("([^"]+)"\)/, "FACTORY_SALT"),
  targetSalt: capture(deployScript, /TARGET_SALT = keccak256\("([^"]+)"\)/, "TARGET_SALT"),
  factoryInitCodeHash: capture(
    deployTest,
    /type\(ConetFactory\)\.creationCode[\s\S]*?(0x[0-9a-f]{64})/,
    "factory init-code hash",
  ),
  factoryRuntimeHash: capture(deployTest, /address\(factory\)\.codehash,\s*(0x[0-9a-f]{64})/, "factory runtime hash"),
  targetRuntimeHash: capture(deployTest, /factory\.target\(\)\.codehash,\s*(0x[0-9a-f]{64})/, "target runtime hash"),
  targetInitCodeHash: capture(factoryTest, /type\(Conet\)\.creationCode\),\s*(0x[0-9a-f]{64})/, "Conet creation-code hash"),
  chainId: capture(envExample, /^CONET_CHAIN_ID=(\d+)$/m, "CONET_CHAIN_ID"),
  factoryBlock: capture(envExample, /^CONET_FACTORY_BLOCK=(\d+)$/m, "CONET_FACTORY_BLOCK"),
};

type Pin = keyof typeof pins;

const surfaces: Record<string, Pin[]> = {
  ".env.example": ["factoryAddress", "chainId", "factoryBlock"],
  "README.md": ["factoryAddress", "targetAddress", "factoryRuntimeHash", "chainId", "factoryBlock"],
  "web/public/skill.md": [
    "factoryAddress",
    "targetAddress",
    "factorySalt",
    "targetSalt",
    "factoryInitCodeHash",
    "factoryRuntimeHash",
    "targetInitCodeHash",
    "targetRuntimeHash",
    "chainId",
  ],
  "web/public/deployment.json": [
    "factoryAddress",
    "targetAddress",
    "factorySalt",
    "targetSalt",
    "factoryInitCodeHash",
    "factoryRuntimeHash",
    "targetInitCodeHash",
    "targetRuntimeHash",
  ],
  "web/README.md": ["factoryAddress", "factoryBlock"],
  "indexer/README.md": ["factoryAddress", "factoryBlock"],
  "eth/README.md": [
    "factoryAddress",
    "targetAddress",
    "factorySalt",
    "targetSalt",
    "factoryInitCodeHash",
    "factoryRuntimeHash",
    "targetInitCodeHash",
    "targetRuntimeHash",
  ],
  "eth/PROTOCOL.md": ["factoryAddress", "targetAddress"],
};

const failures: string[] = [];
for (const [path, required] of Object.entries(surfaces)) {
  const text = (await read(path)).toLowerCase();
  for (const pin of required) {
    if (!text.includes(pins[pin].toLowerCase())) failures.push(`${path} does not carry ${pin} ${pins[pin]}`);
  }
}

const chainSurfaces: Record<string, ("name" | "factoryBlock" | "transactions")[]> = {
  "README.md": ["name", "factoryBlock", "transactions"],
  "web/public/skill.md": ["name", "factoryBlock"],
  "web/public/deployment.json": ["name", "factoryBlock"],
  "web/public/index.md": ["name", "factoryBlock"],
  "web/public/llms.txt": ["name", "factoryBlock"],
  "web/README.md": ["name", "factoryBlock"],
};

if (!DEPLOYMENTS.some((deployment) => String(deployment.chainId) === pins.chainId)) {
  failures.push(`.env.example indexes chain ${pins.chainId}, which web/src/server/deployments.ts does not list`);
}
for (const [path, required] of Object.entries(chainSurfaces)) {
  const text = (await read(path)).toLowerCase();
  for (const deployment of DEPLOYMENTS) {
    const values = required.flatMap((field) => field === "transactions" ? [deployment.factoryTransaction, deployment.targetTransaction] : [String(deployment[field])]);
    for (const value of values) {
      if (!text.includes(value.toLowerCase())) failures.push(`${path} does not carry ${deployment.name} (chain ${deployment.chainId}) ${value}`);
    }
  }
}

for (const [pin, value] of Object.entries(pins)) console.log(`${pin.padEnd(20)} ${value}`);
if (failures.length > 0) {
  console.error(`\n${failures.join("\n")}\n\nRe-pin every surface above from eth/script and eth/test; see .claude/skills/contract-release.`);
  process.exit(1);
}
console.log(`\nall ${Object.keys(surfaces).length} surfaces carry the deployment pins; ${Object.keys(chainSurfaces).length} name all ${DEPLOYMENTS.length} chains`);
