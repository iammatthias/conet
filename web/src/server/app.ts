import { resolve, sep } from "node:path";
import {
  HEARD_TOPIC,
  STATION_MINTED_TOPIC,
  parseHeard,
  parseStationId,
  parseStationMinted,
  stationIdCalldata,
  topicAddress,
  topicUint,
  type RpcLog,
  type StationMinted,
} from "./abi";
import { chainName, type ChainConfig, type ServerConfig } from "./config";
import { chainRouter, escapeHtml, factoryFragment, transmissionFragment } from "./html";
import { DEPLOYMENTS } from "./deployments";
import { boundedRange, CursorError, parseCursor, selectPage, type Cursor, type Page } from "./paging";
import { JsonRpcClient, type ChainReader } from "./rpc";
import { createIndexSource, type IndexSource } from "./index-source";

export interface ChainDependencies {
  chain: ChainReader;
  indexSource?: IndexSource;
}

export interface AppDependencies extends ChainDependencies {
  chains?: Readonly<Record<number, ChainDependencies>>;
  now?: () => number;
}

interface ChainContext extends ChainConfig {
  reader: ChainReader;
  indexSource?: IndexSource;
  registry: StationRegistry;
}

const REJECTION_TTL_MS = 60_000;
const REJECTION_LIMIT = 4_096;

export interface AppHandler {
  (request: Request): Promise<Response>;
  close(): void;
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
    readonly resolution = "Correct the tuner request and try again.",
  ) {
    super(message);
  }
}

function problem(request: Request, error: RequestError | Error): Response {
  const known = error instanceof RequestError;
  const status = known ? error.status : 502;
  return Response.json(
    {
      type: "about:blank",
      title: status === 404 ? "Resource not found" : status === 405 ? "Method not allowed" : "Request failed",
      status,
      detail: error.message,
      code: known ? error.code : "upstream_failure",
      resolution: known ? error.resolution : "Retry later or inspect the configured chain RPC.",
      instance: new URL(request.url).pathname,
    },
    { status, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } },
  );
}

function chainList(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function withDeployment(config: ServerConfig, text: string): string {
  return text
    .replaceAll("{{chainId}}", String(config.chainId))
    .replaceAll("{{chainName}}", chainName(config.chainId))
    .replaceAll("{{factoryAddress}}", config.factoryAddress)
    .replaceAll("{{factoryBlock}}", String(config.factoryBlock));
}

const DEPLOYMENT_DOCUMENTS: Readonly<Record<string, { file: string; contentType: string }>> = Object.freeze({
  "/skill.md": { file: "skill.md", contentType: "text/markdown; charset=utf-8" },
  "/index.md": { file: "index.md", contentType: "text/markdown; charset=utf-8" },
  "/deployment.json": { file: "deployment.json", contentType: "application/json; charset=utf-8" },
});

const SITEMAP_PATHS: readonly string[] = Object.freeze([
  "/",
  "/index.md",
  "/skill.md",
  "/llms.txt",
  "/deployment.json",
  "/abi/ConetFactory.json",
  "/abi/Conet.json",
]);

function requestOrigin(request: Request, url: URL): string {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || forwarded === "http" ? `${forwarded}://${url.host}` : url.origin;
}

function sitemapDocument(origin: string): Response {
  const entries = SITEMAP_PATHS
    .map((path) => `  <url><loc>${escapeHtml(`${origin}${path}`)}</loc></url>`)
    .join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`,
    { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-cache" } },
  );
}

async function robotsDocument(config: ServerConfig, origin: string): Promise<Response> {
  const file = Bun.file(resolve(config.distDir, "robots.txt"));
  if (!(await file.exists())) throw new RequestError("robots document not found", 404);
  return new Response(`${(await file.text()).trimEnd()}\n\nSitemap: ${origin}/sitemap.xml\n`, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" },
  });
}

async function deploymentDocument(config: ServerConfig, pathname: string): Promise<Response> {
  const document = DEPLOYMENT_DOCUMENTS[pathname]!;
  const file = Bun.file(resolve(config.distDir, document.file));
  if (!(await file.exists())) throw new RequestError(`${document.file} not found`, 404);
  return new Response(withDeployment(config, await file.text()), {
    headers: { "content-type": document.contentType, "cache-control": "no-cache" },
  });
}

function address(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new RequestError("invalid Station address");
  return normalized;
}

function limit(url: URL, maximum: number): number {
  const raw = url.searchParams.get("limit") ?? "25";
  if (!/^\d+$/.test(raw)) throw new RequestError("limit must be a positive integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RequestError("limit must be a positive integer");
  }
  return Math.min(value, maximum);
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function requestCursor(value: string | null, minimumBlock: bigint, floorLabel: string): Cursor {
  try {
    return parseCursor(value, minimumBlock);
  } catch (error) {
    if (error instanceof CursorError) {
      throw new RequestError(
        error.message,
        400,
        "invalid_cursor",
        `Use block:logIndex at or after ${floorLabel} ${minimumBlock}.`,
      );
    }
    throw error;
  }
}

async function chainHead(chain: ChainReader, config: ChainConfig): Promise<bigint> {
  const head = await chain.blockNumber();
  return head > config.confirmationDepth ? head - config.confirmationDepth : 0n;
}

function emptyPage<T>(head: bigint, cursor: Cursor): Page<T> {
  return { values: [], cursor, head };
}

async function logsPage<T>(
  chain: ChainReader,
  config: ChainConfig,
  cursor: Cursor,
  pageLimit: number,
  addressValue: string,
  topics: Array<string | null>,
  parse: (log: RpcLog) => T,
) {
  const head = await chainHead(chain, config);
  const range = boundedRange(cursor, head, config.maxBlockRange);
  if (!range) return emptyPage<T>(head, cursor);
  const [fromBlock, toBlock] = range;
  const logs = await chain.getLogs({ address: addressValue, fromBlock, toBlock, topics });
  if (logs.some((log) => log.address.toLowerCase() !== addressValue.toLowerCase())) {
    throw new Error("RPC returned a log outside the requested contract address");
  }
  return selectPage(logs, cursor, toBlock, head, pageLimit, parse);
}

function notRegistered(config: ChainConfig): RequestError {
  return new RequestError(
    `Station was not minted by the factory on ${config.name}`,
    404,
    "station_not_registered",
    `Tune a Station whose stationId on factory ${config.factoryAddress} on chain ${config.chainId} is non-zero.`,
  );
}

class StationRegistry {
  private readonly verified = new Map<string, StationMinted>();
  private readonly rejectedUntil = new Map<string, number>();

  constructor(
    private readonly chain: ChainReader,
    private readonly config: ChainConfig,
    private readonly indexSource: IndexSource | undefined,
    private readonly now: () => number,
  ) {}

  async mint(station: string): Promise<StationMinted> {
    const known = this.verified.get(station);
    if (known) return known;
    const rejected = this.rejectedUntil.get(station);
    if (rejected !== undefined && this.now() < rejected) throw notRegistered(this.config);
    const stationId = parseStationId(await this.chain.call(this.config.factoryAddress, stationIdCalldata(station)));
    if (stationId === 0n) {
      this.reject(station);
      throw notRegistered(this.config);
    }
    const mint = await this.locate(station, stationId);
    this.verified.set(station, mint);
    return mint;
  }

  clear(): void {
    this.verified.clear();
    this.rejectedUntil.clear();
  }

  private reject(station: string): void {
    this.rejectedUntil.delete(station);
    if (this.rejectedUntil.size >= REJECTION_LIMIT) {
      const oldest = this.rejectedUntil.keys().next().value;
      if (oldest !== undefined) this.rejectedUntil.delete(oldest);
    }
    this.rejectedUntil.set(station, this.now() + REJECTION_TTL_MS);
  }

  private async locate(station: string, stationId: bigint): Promise<StationMinted> {
    const indexed = await this.indexSource?.station(station);
    if (indexed && indexed.station === station && indexed.stationId === stationId) return indexed;
    const head = await chainHead(this.chain, this.config);
    for (let fromBlock = this.config.factoryBlock; fromBlock <= head; fromBlock += this.config.maxBlockRange) {
      const last = fromBlock + this.config.maxBlockRange - 1n;
      const logs = await this.chain.getLogs({
        address: this.config.factoryAddress,
        fromBlock,
        toBlock: last < head ? last : head,
        topics: [STATION_MINTED_TOPIC, topicUint(stationId), topicAddress(station)],
      });
      if (logs.length > 1) throw new Error("factory emitted duplicate Station registrations");
      if (logs.length === 1) {
        const mint = parseStationMinted(logs[0]);
        if (mint.station !== station || mint.stationId !== stationId) throw new Error("factory Station topic mismatch");
        return mint;
      }
    }
    throw new RequestError(
      "Station mint is not yet within the tuner's confirmed range",
      404,
      "station_not_confirmed",
      `Retry once the mint is ${this.config.confirmationDepth} blocks deep.`,
    );
  }
}

async function indexDocument(config: ServerConfig, contexts: ReadonlyMap<number, ChainContext>): Promise<Response> {
  const file = Bun.file(resolve(config.distDir, "index.html"));
  if (!(await file.exists())) throw new RequestError("tuner document not found", 404);
  const tunable = Array.from(contexts.values(), (context) => ({
    chainId: context.chainId,
    name: context.name,
    explorer: context.explorerUrl ?? "",
  }));
  const text = withDeployment(config, await file.text())
    .replaceAll("{{factoryRouter}}", chainRouter(`<code>${escapeHtml(config.factoryAddress)}</code>`, config.factoryAddress, DEPLOYMENTS))
    .replaceAll("{{explorerRouter}}", chainRouter("Explorer", config.factoryAddress, DEPLOYMENTS))
    .replaceAll("{{deploymentChains}}", escapeHtml(chainList(DEPLOYMENTS.map((deployment) => deployment.name))))
    .replaceAll("{{tunerChains}}", escapeHtml(JSON.stringify(tunable)))
    .replaceAll("{{explorerUrl}}", config.explorerUrl ?? "");
  return new Response(text, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

async function staticResponse(pathname: string, distDir: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new RequestError("invalid URL encoding");
  }
  const root = resolve(distDir);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new RequestError("invalid static path");
  const file = Bun.file(candidate);
  if (await file.exists()) {
    const headers = new Headers({
      "cache-control": candidate.includes(`${sep}assets${sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    return new Response(file, { headers });
  }
  return new Response("# Not found\n\nSee [/skill.md](/skill.md) for the complete protocol.\n", {
    status: 404,
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
  });
}

const EMBED_PREFLIGHT_HEADERS = Object.freeze({
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "accept",
  "access-control-max-age": "600",
});

function isEmbedSurface(pathname: string): boolean {
  return pathname.startsWith("/_tuner/") || pathname === "/embed.js";
}

function allowedEmbedOrigin(request: Request, url: URL, config: ServerConfig): string | undefined {
  if (!isEmbedSurface(url.pathname)) return undefined;
  const origin = request.headers.get("origin")?.toLowerCase();
  return origin && config.embedOrigins.includes(origin) ? origin : undefined;
}

function withEmbedOrigin(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function chainContexts(config: ServerConfig, dependencies: AppDependencies): ReadonlyMap<number, ChainContext> {
  const now = dependencies.now ?? Date.now;
  const primary: ChainConfig = {
    chainId: config.chainId,
    name: chainName(config.chainId),
    rpcUrl: config.rpcUrl,
    factoryAddress: config.factoryAddress,
    factoryBlock: config.factoryBlock,
    confirmationDepth: config.confirmationDepth,
    maxBlockRange: config.maxBlockRange,
    indexerUrl: config.indexerUrl,
    explorerUrl: config.explorerUrl,
  };
  const entries: Array<[ChainConfig, ChainDependencies | undefined]> = [
    [primary, dependencies],
    ...Array.from(config.chains.values())
      .filter((chain) => chain.chainId !== config.chainId)
      .map((chain): [ChainConfig, ChainDependencies | undefined] => [chain, dependencies.chains?.[chain.chainId]]),
  ];
  return new Map(entries.map(([chain, supplied]) => {
    const reader = supplied?.chain ?? new JsonRpcClient(chain.rpcUrl);
    const indexSource = supplied?.indexSource ?? (chain.indexerUrl ? createIndexSource(chain.indexerUrl) : undefined);
    const registry = new StationRegistry(reader, chain, indexSource, now);
    return [chain.chainId, { ...chain, reader, indexSource, registry }];
  }));
}

function selectedChain(url: URL, contexts: ReadonlyMap<number, ChainContext>, primaryChainId: number): ChainContext {
  const raw = url.searchParams.get("chain");
  const chainId = raw === null || raw === "" ? primaryChainId : /^\d{1,15}$/.test(raw) ? Number(raw) : undefined;
  const context = chainId === undefined ? undefined : contexts.get(chainId);
  if (!context) {
    throw new RequestError(
      "chain is not tuned here",
      400,
      "unknown_chain",
      `Use one of the tuned chain ids: ${Array.from(contexts.keys()).join(", ")}.`,
    );
  }
  return context;
}

export function createApp(config: ServerConfig, dependencies: AppDependencies): AppHandler {
  const contexts = chainContexts(config, dependencies);
  let closed = false;
  const handle = async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const embedOrigin = allowedEmbedOrigin(request, url, config);
    if (embedOrigin && request.method === "OPTIONS") {
      return withEmbedOrigin(new Response(null, { status: 204, headers: EMBED_PREFLIGHT_HEADERS }), embedOrigin);
    }
    const response = await route(request, url);
    return embedOrigin ? withEmbedOrigin(response, embedOrigin) : response;
  };
  const route = async function route(request: Request, url: URL): Promise<Response> {
    try {
      if (closed) {
        throw new RequestError(
          "tuner is shutting down",
          503,
          "tuner_closed",
          "Reconnect after the tuner has restarted.",
        );
      }
      if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
        const response = await indexDocument(config, contexts);
        return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname in DEPLOYMENT_DOCUMENTS) {
        const response = await deploymentDocument(config, url.pathname);
        return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
      }

      if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/sitemap.xml" || url.pathname === "/robots.txt")) {
        const origin = requestOrigin(request, url);
        const response = url.pathname === "/sitemap.xml"
          ? sitemapDocument(origin)
          : await robotsDocument(config, origin);
        return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
      }

      if (request.method === "GET" && url.pathname === "/_tuner/factory/stations") {
        const chain = selectedChain(url, contexts, config.chainId);
        const cursor = requestCursor(url.searchParams.get("cursor"), chain.factoryBlock, `${chain.name} factory block`);
        const pageLimit = limit(url, chain.indexSource ? config.indexPageSize : config.maxPageSize);
        const page = await chain.indexSource?.stations(cursor, pageLimit) ?? await logsPage(
          chain.reader,
          chain,
          cursor,
          pageLimit,
          chain.factoryAddress,
          [STATION_MINTED_TOPIC],
          parseStationMinted,
        );
        return html(factoryFragment(page.values, page.cursor, page.head, chain.chainId, page.highestStationId, chain.explorerUrl));
      }

      const transmissionRoute = /^\/_tuner\/stations\/(0x[0-9a-fA-F]{40})\/transmissions$/.exec(url.pathname);
      if (request.method === "GET" && transmissionRoute) {
        const chain = selectedChain(url, contexts, config.chainId);
        const station = address(transmissionRoute[1]);
        const rawCursor = url.searchParams.get("cursor");
        requestCursor(rawCursor, chain.factoryBlock, `${chain.name} factory block`);
        const pageLimit = limit(url, chain.indexSource ? config.indexPageSize : config.maxPageSize);
        const mint = await chain.registry.mint(station);
        const cursor = requestCursor(rawCursor, mint.blockNumber, "Station mint block");
        const page = await chain.indexSource?.transmissions(station, cursor, pageLimit) ?? await logsPage(
          chain.reader,
          chain,
          cursor,
          pageLimit,
          station,
          [HEARD_TOPIC],
          parseHeard,
        );
        return html(transmissionFragment(page.values, station, mint.stationId.toString(), mint.creator, page.cursor, page.head, chain.explorerUrl));
      }

      if (url.pathname.startsWith("/_tuner/")) {
        throw new RequestError("tuner route not found", 404, "tuner_route_not_found", "Reload the tuner and try again.");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new RequestError(
          "method not allowed",
          405,
          "method_not_allowed",
          "Agents should use Ethereum JSON-RPC and the published contract ABIs directly.",
        );
      }
      const response = await staticResponse(url.pathname, config.distDir);
      return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    } catch (error) {
      return problem(request, error instanceof Error ? error : new Error("unknown server error"));
    }
  };
  handle.close = () => {
    if (closed) return;
    closed = true;
    for (const context of contexts.values()) context.registry.clear();
  };
  return handle;
}
