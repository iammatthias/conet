import { describe, expect, test } from "bun:test";
import type { Heard, StationMinted } from "./abi";
import { factoryFragment, transmissionFragment } from "./html";

const station = "0x1111111111111111111111111111111111111111";
const creator = "0x2222222222222222222222222222222222222222";
const writer = "0x4444444444444444444444444444444444444444";
const transactionHash = `0x${"ab".repeat(32)}`;
const cursor = { block: 4n, logIndex: -1n };
const hostile = `"><img src=x onerror=alert(1)>`;
const escaped = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;";

function heard(overrides: Partial<Heard> = {}): Heard {
  return { seq: 1n, nonce: 0n, writer, kind: 1, cipher: "00ff7f", blockNumber: 3n, logIndex: 0n, transactionHash, ...overrides };
}

describe("transmission rows", () => {
  test("link the block, the transaction, and the writer on the explorer", () => {
    const body = transmissionFragment([heard()], station, "1", cursor, 3n, 2n, "https://explorer.test");
    expect(body).toContain(`href="https://explorer.test/block/3"`);
    expect(body).toContain(`href="https://explorer.test/tx/${transactionHash}"`);
    expect(body).toContain(`href="https://explorer.test/address/${writer}"`);
    expect(body).toContain(">from 0x4444…4444</a>");
    expect(body).toContain(`aria-label="Writer ${writer} of sequence 1 on the block explorer"`);
  });

  test("name the writer as text when no explorer is configured", () => {
    const body = transmissionFragment([heard()], station, "1", cursor, 3n, 2n);
    expect(body).not.toContain("<a ");
    expect(body).toContain("tx from 0x4444…4444");
  });

  test("escape every interpolated field", () => {
    const body = transmissionFragment(
      [heard({ writer: `0x${hostile}${hostile}`, transactionHash: hostile })],
      hostile,
      hostile,
      cursor,
      3n,
      2n,
      `https://explorer.test/${hostile}`,
    );
    expect(body).not.toContain(hostile);
    expect(body).not.toContain("<img");
    expect(body).toContain(`data-station="${escaped}"`);
    expect(body).toContain(`data-station-id="${escaped}"`);
    expect(body).toContain(`href="https://explorer.test/${escaped}/tx/${escaped}"`);
    expect(body).toContain(`href="https://explorer.test/${escaped}/address/0x${escaped}${escaped}"`);
    expect(body).toContain(`aria-label="Writer 0x${escaped}${escaped} of sequence 1`);
  });

  test("refuse a cipher that is not whole hex bytes instead of rendering it", () => {
    expect(() => transmissionFragment([heard({ cipher: hostile })], station, "1", cursor, 3n, 2n)).toThrow();
    expect(() => transmissionFragment([heard({ cipher: "abc" })], station, "1", cursor, 3n, 2n)).toThrow();
  });
});

describe("factory rows", () => {
  test("escape the Station address", () => {
    const mint: StationMinted = { stationId: 1n, station: hostile, creator, blockNumber: 2n, logIndex: 0n };
    const body = factoryFragment([mint], cursor, 3n, 1n);
    expect(body).not.toContain(hostile);
    expect(body).toContain(`data-tune-station="${escaped}"`);
    expect(body).toContain(`data-station-total="1"`);
  });

  test("carry the explorer on the cursor marker only when one is configured", () => {
    const mint: StationMinted = { stationId: 1n, station, creator, blockNumber: 2n, logIndex: 0n };
    expect(factoryFragment([mint], cursor, 3n, 1n, `https://explorer.test/${hostile}`))
      .toContain(`data-explorer="https://explorer.test/${escaped}"`);
    expect(factoryFragment([mint], cursor, 3n, 1n)).not.toContain("data-explorer");
  });
});
