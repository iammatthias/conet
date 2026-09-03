import { describe, expect, test } from "bun:test";
import { decodeHeard, decodeStationMinted, HEARD_TOPIC, STATION_MINTED_TOPIC } from "./chain";

const STATION = `0x${"5A".repeat(20)}`;
const WRITER = `0x${"a".repeat(40)}`;
const CREATOR = `0x${"c".repeat(40)}`;
const TX = `0x${"1".repeat(64)}`;

const VECTOR_4_WORDS = [
  "0000000000000000000000000000000000000000000000000123456789abcdef",
  "0000000000000000000000000000000000000000000000000000000000000001",
  "0000000000000000000000000000000000000000000000000000000000000060",
  "000000000000000000000000000000000000000000000000000000000000001c",
  "c9eb05fde61065bea197e55aedf988395db39ec2fbcec4d181efb83d00000000",
];

function word(value: number | string): string {
  const hex = typeof value === "number" ? value.toString(16) : value.slice(2);
  return `0x${hex.padStart(64, "0")}`;
}

function heardLog(words: string[]) {
  return {
    address: STATION,
    topics: [HEARD_TOPIC, word(7), word(WRITER)],
    data: `0x${words.join("")}`,
    blockNumber: "0x10",
    logIndex: "0x2",
    transactionHash: TX,
  };
}

describe("event decoding", () => {
  test("reads the Vector 4 Heard data section with the cipher cut to its declared length", () => {
    expect(decodeHeard(heardLog(VECTOR_4_WORDS))).toEqual({
      station: STATION.toLowerCase(),
      seq: 7,
      nonce: "0123456789abcdef",
      writer: WRITER,
      kind: 1,
      cipher: "c9eb05fde61065bea197e55aedf988395db39ec2fbcec4d181efb83d",
      blockNumber: 16,
      logIndex: 2,
      transactionHash: TX,
    });
  });

  test("refuses a data section whose cipher offset is not the canonical 0x60", () => {
    const words = [...VECTOR_4_WORDS];
    words[2] = word(0x80).slice(2);
    expect(() => decodeHeard(heardLog(words))).toThrow("non-canonical offset");
  });

  test("refuses a cipher shorter than its declared length", () => {
    const words = [...VECTOR_4_WORDS];
    words[3] = word(0x40).slice(2);
    expect(() => decodeHeard(heardLog(words))).toThrow("truncated");
  });

  test("reads StationMinted from its three indexed topics", () => {
    expect(decodeStationMinted({
      address: `0x${"f".repeat(40)}`,
      topics: [STATION_MINTED_TOPIC, word(3), word(STATION), word(CREATOR)],
      data: "0x",
      blockNumber: "0x2c1d4b4",
      logIndex: "0x0",
      transactionHash: TX,
    })).toEqual({
      stationId: 3,
      address: STATION.toLowerCase(),
      creator: CREATOR,
      blockNumber: 46257332,
      logIndex: 0,
    });
  });
});
