export interface TunerChain {
  chainId: number;
  name: string;
  explorer?: string;
}

export interface ReceiverPosition {
  chain?: number;
  primaryChain?: number;
  station: string;
}

const EXPLORER_ORIGIN = /^https:\/\/[a-z0-9.-]+(?:\/[\w./-]*)?$/i;

export function explorerOrigin(value: string | undefined): string | undefined {
  return value && EXPLORER_ORIGIN.test(value) ? value : undefined;
}

export function chainId(value: string | null | undefined): number | undefined {
  if (!value || !/^\d{1,15}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= 1 ? parsed : undefined;
}

export function tunerPath(route: string, chain: number | undefined, query: Readonly<Record<string, string | undefined>>): string {
  const params = new URLSearchParams();
  if (chain !== undefined) params.set("chain", String(chain));
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(name, value);
  }
  const search = params.toString();
  return search ? `${route}?${search}` : route;
}

export function receiverSearch(search: string, position: ReceiverPosition): string {
  const params = new URLSearchParams(search);
  if (position.chain === undefined || position.chain === position.primaryChain) params.delete("chain");
  else params.set("chain", String(position.chain));
  if (position.station) params.set("station", position.station);
  else params.delete("station");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function tunerChains(raw: string | undefined): TunerChain[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown): TunerChain[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { chainId: id, name, explorer } = entry as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || typeof name !== "string" || name === "") return [];
    return [{ chainId: id, name, explorer: explorerOrigin(typeof explorer === "string" ? explorer : undefined) }];
  });
}
