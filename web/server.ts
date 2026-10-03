import { createApp, type ChainDependencies } from "./src/server/app";
import { verifyChainStartupPatiently } from "./src/server/bootstrap";
import { loadConfig } from "./src/server/config";
import { JsonRpcClient } from "./src/server/rpc";

const config = loadConfig();
const readers = Array.from(config.chains.values(), (chain) => ({ chain, reader: new JsonRpcClient(chain.rpcUrl) }));
await Promise.all(readers.map(({ chain, reader }) => verifyChainStartupPatiently(chain, reader)));

const chains: Record<number, ChainDependencies> = Object.fromEntries(readers.map(({ chain, reader }) => [chain.chainId, { chain: reader }]));

const app = createApp(config, { ...chains[config.chainId], chains });
const server = Bun.serve({
  port: config.port,
  fetch: app,
});

console.log(`CONET tuner listening on ${server.url}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  app.close();
  await server.stop();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch((error) => {
      console.error("CONET tuner shutdown failed", error);
      process.exitCode = 1;
    });
  });
}
