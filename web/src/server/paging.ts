import type { RpcLog } from "./abi";

export interface Cursor {
  block: bigint;
  logIndex: bigint;
}

export interface Page<T> {
  values: T[];
  cursor: Cursor;
  head: bigint;
  highestStationId?: bigint;
}

export class CursorError extends Error {}

export function parseCursor(value: string | null, minimumBlock: bigint): Cursor {
  if (value === null) return { block: minimumBlock, logIndex: -1n };
  if (value.length > 160) throw new CursorError("cursor is too long");
  const match = /^(\d+):(-1|\d+)$/.exec(value);
  if (!match) throw new CursorError("cursor must be block:logIndex");
  const cursor = { block: BigInt(match[1]), logIndex: BigInt(match[2]) };
  if (cursor.block < minimumBlock) {
    throw new CursorError(`cursor block must be at least ${minimumBlock}`);
  }
  return cursor;
}

export function formatCursor(cursor: Cursor): string {
  return `${cursor.block}:${cursor.logIndex}`;
}

export function boundedRange(cursor: Cursor, head: bigint, maxBlockRange: bigint): [bigint, bigint] | null {
  if (maxBlockRange < 1n) throw new Error("maxBlockRange must be positive");
  if (cursor.block > head) return null;
  const last = cursor.block + maxBlockRange - 1n;
  return [cursor.block, last < head ? last : head];
}

function position(log: RpcLog): Cursor {
  return { block: BigInt(log.blockNumber), logIndex: BigInt(log.logIndex) };
}

function after(left: Cursor, right: Cursor): boolean {
  return left.block > right.block || (left.block === right.block && left.logIndex > right.logIndex);
}

export function selectPage<T>(
  logs: RpcLog[],
  cursor: Cursor,
  scannedTo: bigint,
  head: bigint,
  limit: number,
  parse: (log: RpcLog) => T,
): Page<T> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be positive");
  const ordered = [...logs].sort((a, b) => {
    const ap = position(a);
    const bp = position(b);
    return ap.block === bp.block
      ? ap.logIndex < bp.logIndex
        ? -1
        : ap.logIndex > bp.logIndex
          ? 1
          : 0
      : ap.block < bp.block
        ? -1
        : 1;
  });
  const eligible = ordered.filter((log) => after(position(log), cursor));
  const selected = eligible.slice(0, limit);
  const values = selected.map(parse);
  const next = selected.length < eligible.length
    ? position(selected[selected.length - 1])
    : { block: scannedTo + 1n, logIndex: -1n };
  return { values, cursor: next, head };
}
