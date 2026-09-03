import { describe, expect, test } from "bun:test";
import { boundedRange, parseCursor, selectPage } from "./paging";
import type { RpcLog } from "./abi";

const log = (block: number, index: number): RpcLog => ({
  address: "0x1111111111111111111111111111111111111111",
  topics: [],
  data: "0x",
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${index.toString(16)}`,
});

describe("bounded cursor paging", () => {
  test("never scans beyond the configured range", () => {
    expect(boundedRange(parseCursor(null, 10n), 10_000n, 100n)).toEqual([10n, 109n]);
  });

  test("preserves log position when a page ends within one block", () => {
    const logs = [log(4, 2), log(4, 0), log(4, 1)];
    const first = selectPage(logs, { block: 4n, logIndex: -1n }, 4n, 4n, 2, (value) => value.logIndex);
    expect(first.values).toEqual(["0x0", "0x1"]);
    expect(first.cursor).toEqual({ block: 4n, logIndex: 1n });

    const second = selectPage(logs, first.cursor, 4n, 4n, 2, (value) => value.logIndex);
    expect(second.values).toEqual(["0x2"]);
    expect(second.cursor).toEqual({ block: 5n, logIndex: -1n });
  });

  test("deduplicates an overlapping cursor boundary without dropping later logs", () => {
    const first = selectPage([log(9, 0), log(9, 1)], { block: 9n, logIndex: -1n }, 9n, 9n, 1, (value) => value.logIndex);
    const second = selectPage([log(9, 0), log(9, 1)], first.cursor, 9n, 9n, 1, (value) => value.logIndex);

    expect(first.values).toEqual(["0x0"]);
    expect(second.values).toEqual(["0x1"]);
    expect(second.cursor).toEqual({ block: 10n, logIndex: -1n });
  });

  test("advances past a fully scanned empty range", () => {
    const page = selectPage([], { block: 7n, logIndex: -1n }, 12n, 12n, 10, () => null);
    expect(page.cursor).toEqual({ block: 13n, logIndex: -1n });
  });

  test("rejects malformed cursors", () => {
    expect(() => parseCursor("latest", 0n)).toThrow("block:logIndex");
    expect(() => parseCursor("", 0n)).toThrow("block:logIndex");
    expect(() => parseCursor(`${"1".repeat(160)}:0`, 0n)).toThrow("too long");
  });

  test("rejects cursors below the configured floor", () => {
    expect(() => parseCursor("9:-1", 10n)).toThrow("at least 10");
    expect(parseCursor("10:-1", 10n)).toEqual({ block: 10n, logIndex: -1n });
  });
});
