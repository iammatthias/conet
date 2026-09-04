import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import {
  HEARD_TOPIC,
  STATION_ID_SELECTOR,
  STATION_MINTED_TOPIC,
  parseStationMinted,
  topicAddress,
  topicUint,
  type RpcLog,
  type StationMinted,
} from "./abi";
import type { ServerConfig } from "./config";
import type { IndexSource } from "./index-source";
import type { ChainReader, LogFilter } from "./rpc";

const station = "0x1111111111111111111111111111111111111111";
const creator = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const writer = "0x4444444444444444444444444444444444444444";
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const transmissionsPath = `/_tuner/stations/${station}/transmissions`;
const flowed = (text: string) => text.replace(/\s+/g, " ");

const config = (): ServerConfig => ({
  rpcUrl: "http://configured.invalid",
  chainId: 31_337,
  factoryAddress: factory,
  factoryBlock: 2n,
  confirmationDepth: 0n,
  maxBlockRange: 10n,
  maxPageSize: 25,
  indexPageSize: 1_000,
  port: 3000,
  distDir: "/path/that/does/not/exist",
  embedOrigins: ["https://iammatthias.com"],
});

function event(cipher = "00ff7f"): RpcLog {
  const byteLength = cipher.length / 2;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) throw new Error("test cipher must contain whole bytes");
  const padded = cipher.padEnd(Math.ceil(cipher.length / 64) * 64, "0");
  return {
    address: station,
    topics: [HEARD_TOPIC, topicUint(1n), topicAddress(writer)],
    data: `0x${word(42n)}${word(1n)}${word(96n)}${word(BigInt(byteLength))}${padded}`,
    blockNumber: "0x3",
    logIndex: "0x0",
  };
}

function mintAt(
  stationAddress: string,
  stationId: bigint,
  blockNumber = 2n,
  logIndex = 0n,
): RpcLog {
  return {
    address: factory,
    topics: [STATION_MINTED_TOPIC, topicUint(stationId), topicAddress(stationAddress), topicAddress(creator)],
    data: "0x",
    blockNumber: `0x${blockNumber.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

function mint(): RpcLog {
  return mintAt(station, 1n);
}

function registryOf(logs: RpcLog[]): Record<string, bigint> {
  const registry: Record<string, bigint> = {};
  for (const log of logs) {
    if (log.topics[0] !== STATION_MINTED_TOPIC) continue;
    const minted = parseStationMinted(log);
    registry[minted.station] = minted.stationId;
  }
  return registry;
}

interface FakeChain extends ChainReader {
  reads: string[];
  logCalls: LogFilter[];
  registryCalls: string[];
}

function fakeChain(logs: RpcLog[], head = 3n, registry = registryOf(logs)): FakeChain {
  const reads: string[] = [];
  const logCalls: LogFilter[] = [];
  const registryCalls: string[] = [];
  return {
    reads,
    logCalls,
    registryCalls,
    blockNumber: async () => {
      reads.push("eth_blockNumber");
      return head;
    },
    getLogs: async (filter) => {
      reads.push("eth_getLogs");
      logCalls.push(filter);
      return logs.filter((log) => {
        const block = BigInt(log.blockNumber);
        return log.address === filter.address
          && block >= filter.fromBlock
          && block <= filter.toBlock
          && filter.topics.every((topic, index) => topic === null || topic === log.topics[index]);
      });
    },
    call: async (to, data) => {
      reads.push("eth_call");
      if (to !== factory || !data.startsWith(STATION_ID_SELECTOR)) throw new Error(`unexpected call to ${to}`);
      const queried = `0x${data.slice(-40)}`;
      registryCalls.push(queried);
      return topicUint(registry[queried] ?? 0n);
    },
  };
}

const indexedMint: StationMinted = { stationId: 1n, station, creator, blockNumber: 2n, logIndex: 0n };

function fakeIndex(overrides: Partial<IndexSource> = {}): IndexSource {
  return {
    stations: async () => undefined,
    transmissions: async () => undefined,
    station: async () => undefined,
    ...overrides,
  };
}

function listenerPaths(query: string): string[] {
  return [
    `/_tuner/factory/stations?${query}`,
    `${transmissionsPath}?${query}`,
  ];
}

describe("Bun Station server", () => {
  test("rejects new work after shutdown", async () => {
    const app = createApp(config(), { chain: fakeChain([]) });

    app.close();
    app.close();

    const response = await app(new Request("http://local/skill.md"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "tuner_closed" });
  });

  test("serves the skill with this deployment's coordinates substituted, without touching the chain", async () => {
    const distDir = `${import.meta.dir}/../../node_modules/.cache/skill-route-test`;
    const { mkdirSync, rmSync, copyFileSync } = await import("node:fs");
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
    copyFileSync(`${import.meta.dir}/../../public/skill.md`, `${distDir}/skill.md`);
    const chain = fakeChain([]);
    const response = await createApp({ ...config(), distDir }, { chain })(new Request("http://local/skill.md"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(chain.reads).toEqual([]);
    const skill = await response.text();
    expect(skill).toContain("chainId: 31337");
    expect(skill).toContain(`factory: ${factory}`);
    expect(skill).toContain("factory deployment block: 2");
    expect(skill).not.toContain("{{");
    rmSync(distDir, { recursive: true, force: true });
  });

  test("serves every answer surface with this deployment's coordinates and no surviving placeholder", async () => {
    const distDir = `${import.meta.dir}/../../node_modules/.cache/answer-surface-test`;
    const { mkdirSync, rmSync, copyFileSync } = await import("node:fs");
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
    for (const name of ["index.md", "deployment.json", "llms.txt"]) {
      copyFileSync(`${import.meta.dir}/../../public/${name}`, `${distDir}/${name}`);
    }
    copyFileSync(`${import.meta.dir}/../../index.html`, `${distDir}/index.html`);
    const chain = fakeChain([]);
    const app = createApp({ ...config(), distDir, explorerUrl: "https://explorer.test" }, { chain });

    const deployment = await app(new Request("http://local/deployment.json"));
    expect(deployment.status).toBe(200);
    expect(deployment.headers.get("content-type")).toContain("application/json");
    const coordinates = JSON.parse(await deployment.text()) as {
      deployment: { chainId: number; chainName: string; factory: string; factoryDeploymentBlock: number };
      v3: { factory: { address: string }; eventTopics: { Heard: string } };
      protocol: string;
    };
    expect(coordinates.deployment).toEqual({ chainId: 31_337, chainName: "Anvil", factory, factoryDeploymentBlock: 2 });
    expect(coordinates.v3.factory.address.toLowerCase()).toBe("0xb084351e5fd70d318a2264bc8af63c4575db8844");
    expect(coordinates.v3.eventTopics.Heard).toBe(HEARD_TOPIC);
    expect(coordinates.protocol).toBe("/skill.md");

    const overview = await app(new Request("http://local/index.md"));
    expect(overview.status).toBe(200);
    expect(overview.headers.get("content-type")).toContain("text/markdown");
    const overviewText = await overview.text();
    expect(flowed(overviewText)).toContain(`Anvil, chainId 31337 \u00b7 factory \`${factory}\` \u00b7 from block 2`);
    expect(overviewText).not.toContain("{{");

    const page = await app(new Request("http://local/"));
    const pageText = await page.text();
    expect(flowed(pageText)).toContain(`Anvil, chainId 31337 \u00b7 factory <code>${factory}</code>`);
    expect(pageText).not.toContain("{{");

    const llms = await app(new Request("http://local/llms.txt"));
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain("/skill.md");

    expect(chain.reads).toEqual([]);
    rmSync(distDir, { recursive: true, force: true });
  });

  test("lists every answer surface in a sitemap the request's own origin anchors", async () => {
    const distDir = `${import.meta.dir}/../../node_modules/.cache/sitemap-test`;
    const { mkdirSync, rmSync, copyFileSync } = await import("node:fs");
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
    copyFileSync(`${import.meta.dir}/../../public/robots.txt`, `${distDir}/robots.txt`);
    const app = createApp({ ...config(), distDir }, { chain: fakeChain([]) });

    const sitemap = await app(new Request("http://local/sitemap.xml"));
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    const xml = await sitemap.text();
    for (const path of ["/", "/index.md", "/skill.md", "/llms.txt", "/deployment.json", "/abi/ConetFactory.json", "/abi/Conet.json"]) {
      expect(xml).toContain(`<loc>http://local${path}</loc>`);
    }

    const proxied = await app(new Request("http://local/sitemap.xml", { headers: { "x-forwarded-proto": "https" } }));
    expect(await proxied.text()).toContain("<loc>https://local/skill.md</loc>");

    const robots = await app(new Request("http://local/robots.txt"));
    const directives = await robots.text();
    expect(directives).toContain("Allow: /");
    expect(directives).toContain("Sitemap: http://local/sitemap.xml");
    rmSync(distDir, { recursive: true, force: true });
  });

  test("returns a 404 problem when the skill document is missing from dist", async () => {
    const response = await createApp(config(), { chain: fakeChain([]) })(new Request("http://local/skill.md"));
    expect(response.status).toBe(404);
  });

  test("publishes the contract ABIs and treats tuner routes as private plumbing", async () => {
    const factoryAbi = await Bun.file(new URL("../../public/abi/ConetFactory.json", import.meta.url)).json() as Array<{ name?: string }>;
    const stationAbi = await Bun.file(new URL("../../public/abi/Conet.json", import.meta.url)).json() as Array<{ name?: string }>;
    expect(factoryAbi.some(({ name }) => name === "StationMinted")).toBe(true);
    expect(stationAbi.some(({ name }) => name === "Heard")).toBe(true);

    const app = createApp(config(), { chain: fakeChain([]) });
    const missing = await app(new Request("http://station.local/_tuner/missing"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "tuner_route_not_found",
      resolution: "Reload the tuner and try again.",
    });
  });

  test("rejects malformed, empty, and below-floor cursors before any RPC", async () => {
    for (const cursor of ["latest", "", "1:-1"]) {
      for (const path of listenerPaths(`cursor=${encodeURIComponent(cursor)}`)) {
        const chain = fakeChain([mint()]);
        const response = await createApp(config(), { chain })(new Request(`http://local${path}`));

        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
        expect(chain.reads).toEqual([]);
      }
    }
  });

  test("validates listener limits before Station provenance RPC", async () => {
    for (const path of listenerPaths("limit=0")) {
      const chain = fakeChain([mint()]);
      const response = await createApp(config(), { chain })(new Request(`http://local${path}`));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
      expect(chain.reads).toEqual([]);
    }
  });

  test("accepts the configured cursor floor and never queries below it", async () => {
    const factoryChain = fakeChain([]);
    const factoryResponse = await createApp(config(), { chain: factoryChain })(
      new Request("http://local/_tuner/factory/stations?cursor=2:-1"),
    );
    expect(factoryResponse.status).toBe(200);
    expect(factoryChain.logCalls).toHaveLength(1);
    expect(factoryChain.logCalls[0].fromBlock).toBe(2n);

    const stationChain = fakeChain([mint()]);
    const stationResponse = await createApp(config(), { chain: stationChain })(
      new Request(`http://local${transmissionsPath}?cursor=2:-1`),
    );
    expect(stationResponse.status).toBe(200);
    expect(stationChain.logCalls).toHaveLength(2);
    expect(stationChain.logCalls.every((call) => call.fromBlock >= 2n)).toBeTrue();
  });

  test("clamps a listener limit above the server maximum instead of refusing the page", async () => {
    for (const path of listenerPaths("limit=1000")) {
      const response = await createApp(config(), { chain: fakeChain([mint()]) })(
        new Request(`http://local${path}`),
      );
      expect(response.status).toBe(200);
    }
  });

  test("renders bounded factory frequency metadata", async () => {
    const chain = fakeChain([mint()]);
    const response = await createApp(config(), { chain })(
      new Request("http://local/_tuner/factory/stations?limit=2"),
    );
    expect(response.status).toBe(200);
    expect(chain.logCalls[0]).toMatchObject({ fromBlock: 2n, toBlock: 3n, address: factory });
    const body = await response.text();
    expect(body).toContain("data-known-frequency");
    expect(body).toContain("data-station-id=\"1\"");
    expect(body).toContain(`data-tune-station=\"${station}\"`);
    expect(body).toContain("data-station-cursor=\"4:-1\"");
  });

  test("carries the configured explorer on the factory fragment for the embed", async () => {
    const listing = await createApp({ ...config(), explorerUrl: "https://explorer.test" }, { chain: fakeChain([mint()]) })(
      new Request("http://local/_tuner/factory/stations"),
    );
    expect(await listing.text()).toContain('data-explorer="https://explorer.test"');
    const bare = await createApp(config(), { chain: fakeChain([mint()]) })(
      new Request("http://local/_tuner/factory/stations"),
    );
    expect(await bare.text()).not.toContain("data-explorer");
  });

  test("walks every factory page across block windows and same-block page boundaries", async () => {
    const stationAddress = (id: bigint) => `0x${id.toString(16).padStart(40, "0")}`;
    const chain = fakeChain([
      mintAt(stationAddress(1n), 1n, 2n, 0n),
      mintAt(stationAddress(2n), 2n, 3n, 0n),
      mintAt(stationAddress(3n), 3n, 3n, 1n),
      mintAt(stationAddress(4n), 4n, 3n, 2n),
      mintAt(stationAddress(5n), 5n, 4n, 0n),
      mintAt(stationAddress(6n), 6n, 8n, 0n),
      mintAt(stationAddress(7n), 7n, 12n, 0n),
    ], 12n);
    const pageConfig = { ...config(), maxBlockRange: 3n, maxPageSize: 2 };
    const app = createApp(pageConfig, { chain });
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let requestCount = 0; requestCount < 12; requestCount += 1) {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const response = await app(new Request(`http://local/_tuner/factory/stations${query}`));
      expect(response.status).toBe(200);
      const body = await response.text();
      seen.push(...Array.from(body.matchAll(/data-station-id="(\d+)"/g), (match) => match[1]));
      cursor = body.match(/data-station-cursor="([^"]+)"/)?.[1];
      expect(cursor).toBeDefined();
      if (BigInt(cursor!.split(":", 1)[0]) > 12n) break;
    }

    expect(seen).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(cursor).toBe("13:-1");
    expect(chain.logCalls.every((call) => call.toBlock - call.fromBlock < 3n)).toBeTrue();
  });

  test("anchors transmission scans and cursors to the Station mint block", async () => {
    const chain = fakeChain([mintAt(station, 1n, 5n), { ...event(), blockNumber: "0x6" }], 8n);
    const app = createApp(config(), { chain });

    const belowMint = await app(new Request(`http://local${transmissionsPath}?cursor=3:-1`));
    expect(belowMint.status).toBe(400);
    expect(await belowMint.json()).toMatchObject({
      code: "invalid_cursor",
      resolution: "Use block:logIndex at or after Station mint block 5.",
    });

    chain.logCalls.length = 0;
    const response = await app(new Request(`http://local${transmissionsPath}`));
    expect(response.status).toBe(200);
    const heardCall = chain.logCalls.find((call) => call.topics[0] === HEARD_TOPIC);
    expect(heardCall?.fromBlock).toBe(5n);
    const body = await response.text();
    expect(body).toContain("data-block=\"6\"");
  });

  test("trails the chain head by the configured confirmation depth", async () => {
    const chain = fakeChain([mint(), event()]);
    const app = createApp({ ...config(), confirmationDepth: 1n }, { chain });

    const factoryResponse = await app(new Request("http://local/_tuner/factory/stations"));
    expect(factoryResponse.status).toBe(200);
    expect(chain.logCalls[0].toBlock).toBe(2n);
    expect(await factoryResponse.text()).toContain("data-chain-head=\"2\"");
  });

  test("caches only hashed assets", async () => {
    const distDir = `${import.meta.dir}/../../node_modules/.cache/static-headers-test`;
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(`${distDir}/assets`, { recursive: true });
    writeFileSync(`${distDir}/index.html`, "<title>t</title>");
    writeFileSync(`${distDir}/assets/app-abc123.js`, "export {}");
    const app = createApp({ ...config(), distDir }, { chain: fakeChain([]) });

    const page = await app(new Request("http://local/"));
    expect(page.headers.get("cache-control")).toBe("no-cache");

    const asset = await app(new Request("http://local/assets/app-abc123.js"));
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    rmSync(distDir, { recursive: true, force: true });
  });

  test("rejects logs returned outside the requested contract filter", async () => {
    const wrongFactory = "0x4444444444444444444444444444444444444444";
    const response = await createApp(config(), {
      chain: {
        blockNumber: async () => 3n,
        getLogs: async () => [{ ...mint(), address: wrongFactory }],
        call: async () => topicUint(0n),
      },
    })(new Request("http://local/_tuner/factory/stations"));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "upstream_failure",
      detail: "RPC returned a log outside the requested contract address",
    });
  });

  test("renders transmission rows using the front-panel data contract", async () => {
    const response = await createApp(config(), { chain: fakeChain([mint(), event()]) })(
      new Request(`http://local${transmissionsPath}`),
    );
    const body = await response.text();
    expect(body).toContain("<span data-transmission");
    expect(body).toContain(`data-station=\"${station}\"`);
    expect(body).toContain("data-seq=\"1\"");
    expect(body).toContain("data-block=\"3\"");
    expect(body).toContain("data-cipher=\"00ff7f\"");
    expect(body).toContain("data-station-id=\"1\"");
    expect(body).toContain("data-group-count=\"1\"");
    expect(body).toContain("from 0x4444…4444");
    expect(body).toContain('<span class="groups">65407</span>');
  });
});

describe("Station provenance", () => {
  test("refuses an address the factory never minted without scanning any history", async () => {
    const chain = fakeChain([]);
    const response = await createApp(config(), { chain })(new Request(`http://local${transmissionsPath}`));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "station_not_registered" });
    expect(chain.registryCalls).toEqual([station]);
    expect(chain.reads).toEqual(["eth_call"]);
  });

  test("remembers a refusal for a minute so a hammered address costs one call", async () => {
    let now = 1_000_000;
    const chain = fakeChain([]);
    const app = createApp(config(), { chain, now: () => now });
    const request = () => app(new Request(`http://local${transmissionsPath}`));

    expect((await request()).status).toBe(404);
    now += 59_999;
    expect((await request()).status).toBe(404);
    expect(chain.registryCalls).toHaveLength(1);

    now += 1;
    expect((await request()).status).toBe(404);
    expect(chain.registryCalls).toHaveLength(2);
    expect(chain.logCalls).toEqual([]);
  });

  test("locates a registered Station's mint through the fully indexed topic filter and reuses it", async () => {
    const chain = fakeChain([mint(), event()]);
    const app = createApp(config(), { chain });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app(new Request(`http://local${transmissionsPath}`));
      expect(response.status).toBe(200);
    }

    expect(chain.registryCalls).toEqual([station]);
    const mintScans = chain.logCalls.filter((call) => call.address === factory);
    expect(mintScans).toHaveLength(1);
    expect(mintScans[0].topics).toEqual([STATION_MINTED_TOPIC, topicUint(1n), topicAddress(station)]);
    expect(chain.logCalls.filter((call) => call.address === station)).toHaveLength(2);
  });

  test("reports a registered Station whose mint is still beyond the confirmed head", async () => {
    const chain = fakeChain([mintAt(station, 1n, 3n)], 3n);
    const response = await createApp({ ...config(), confirmationDepth: 1n }, { chain })(
      new Request(`http://local${transmissionsPath}`),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "station_not_confirmed" });
    expect(chain.logCalls.map((call) => call.address)).toEqual([factory]);
  });

  test("takes the mint position from an index that names the same Station id", async () => {
    const chain = fakeChain([mint(), event()]);
    const indexSource = fakeIndex({ station: async (address) => address === station ? indexedMint : undefined });
    const response = await createApp(config(), { chain, indexSource })(new Request(`http://local${transmissionsPath}`));

    expect(response.status).toBe(200);
    expect(chain.registryCalls).toEqual([station]);
    expect(chain.logCalls.map((call) => call.address)).toEqual([station]);
    expect(await response.text()).toContain(`data-station="${station}"`);
  });

  test("scans the chain when the index names a different Station id", async () => {
    const chain = fakeChain([mint(), event()]);
    const indexSource = fakeIndex({ station: async () => ({ ...indexedMint, stationId: 9n, blockNumber: 1n }) });
    const response = await createApp(config(), { chain, indexSource })(new Request(`http://local${transmissionsPath}`));

    expect(response.status).toBe(200);
    expect(chain.logCalls.map((call) => call.address)).toEqual([factory, station]);
    expect(await response.text()).toContain(`data-station="${station}"`);
  });

  test("lists index rows without letting them stand in for provenance", async () => {
    const chain = fakeChain([]);
    const indexSource = fakeIndex({
      stations: async () => ({ values: [indexedMint], cursor: { block: 4n, logIndex: -1n }, head: 3n }),
      station: async () => indexedMint,
    });
    const app = createApp(config(), { chain, indexSource });

    const listing = await app(new Request("http://local/_tuner/factory/stations"));
    expect(listing.status).toBe(200);
    expect(await listing.text()).toContain(`data-tune-station=\"${station}\"`);
    expect(chain.reads).toEqual([]);

    const tuned = await app(new Request(`http://local${transmissionsPath}`));
    expect(tuned.status).toBe(404);
    expect(await tuned.json()).toMatchObject({ code: "station_not_registered" });
    expect(chain.reads).toEqual(["eth_call"]);
  });

  test("falls back to RPC pages whenever the index declines", async () => {
    const chain = fakeChain([mint(), event()]);
    const app = createApp(config(), { chain, indexSource: fakeIndex() });

    const listing = await app(new Request("http://local/_tuner/factory/stations"));
    expect(await listing.text()).toContain("data-station-id=\"1\"");

    const tuned = await app(new Request(`http://local${transmissionsPath}`));
    expect(await tuned.text()).toContain("data-seq=\"1\"");
    expect(chain.logCalls.map((call) => call.address)).toEqual([factory, factory, station]);
  });

  test("the embed surface answers only allowlisted origins, and only on tuner routes", async () => {
    const app = createApp(config(), { chain: fakeChain([]) });
    const fragment = "http://local/_tuner/factory/stations";

    const allowed = await app(new Request(fragment, { headers: { origin: "https://iammatthias.com" } }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://iammatthias.com");
    expect(allowed.headers.get("vary")).toBe("origin");
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();

    const stranger = await app(new Request(fragment, { headers: { origin: "https://evil.example" } }));
    expect(stranger.status).toBe(200);
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();

    const anonymous = await app(new Request(fragment));
    expect(anonymous.headers.get("access-control-allow-origin")).toBeNull();

    const page = await app(new Request("http://local/", { headers: { origin: "https://iammatthias.com" } }));
    expect(page.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await app(new Request(fragment, { method: "OPTIONS", headers: { origin: "https://iammatthias.com" } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET");
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://iammatthias.com");

    const strangerPreflight = await app(new Request(fragment, { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(strangerPreflight.status).toBe(404);
    expect(strangerPreflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("nothing that is not found may be cached by an edge", async () => {
    const app = createApp(config(), { chain: fakeChain([]) });
    for (const path of ["/embed.js", "/nope", "/_tuner/missing"]) {
      const response = await app(new Request(`http://local${path}`));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
