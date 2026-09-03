import { createApp } from "./src/server/app";
import { verifyChainStartup } from "./src/server/bootstrap";
import { loadConfig } from "./src/server/config";
import { JsonRpcClient } from "./src/server/rpc";

const config = loadConfig();
const chain = new JsonRpcClient(config.rpcUrl);
await verifyChainStartup(config, chain);

const app = createApp(config, { chain });
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
