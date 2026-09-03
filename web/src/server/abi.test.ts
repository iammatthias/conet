import { describe, expect, test } from "bun:test";
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
} from "./abi";

const word = (value: bigint) => value.toString(16).padStart(64, "0");
const padBytes = (hex: string) => hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");

function heardLog(cipher = "0102ff"): RpcLog {
  return {
    address: "0x1111111111111111111111111111111111111111",
    topics: [HEARD_TOPIC, topicUint(7n), topicAddress("0x4444444444444444444444444444444444444444")],
    data: `0x${word(0xaabbccddn)}${word(2n)}${word(96n)}${word(BigInt(cipher.length / 2))}${padBytes(cipher)}`,
    blockNumber: "0x10",
    logIndex: "0x2",
    transactionHash: `0x${"ab".repeat(32)}`,
  };
}

describe("strict Station ABI parsing", () => {
  test("decodes canonical Heard data", () => {
    expect(parseHeard(heardLog())).toMatchObject({
      seq: 7n,
      nonce: 0xaabbccddn,
      writer: "0x4444444444444444444444444444444444444444",
      kind: 2,
      cipher: "0102ff",
      blockNumber: 16n,
      logIndex: 2n,
    });
  });

  test("rejects non-canonical Heard padding", () => {
    const log = heardLog();
    log.data = `${log.data.slice(0, -1)}1`;
    expect(() => parseHeard(log)).toThrow("non-zero Heard ABI padding");
  });

  test("rejects trailing ABI words", () => {
    const log = heardLog();
    log.data += "00".repeat(32);
    expect(() => parseHeard(log)).toThrow("Heard ABI length mismatch");
  });

  test("decodes a canonical StationMinted event", () => {
    const station = "0x2222222222222222222222222222222222222222";
    const creator = "0x3333333333333333333333333333333333333333";
    const log: RpcLog = {
      address: "0x4444444444444444444444444444444444444444",
      topics: [STATION_MINTED_TOPIC, topicUint(3n), topicAddress(station), topicAddress(creator)],
      data: "0x",
      blockNumber: "0x5",
      logIndex: "0x0",
    };
    expect(parseStationMinted(log)).toEqual({ stationId: 3n, station, creator, blockNumber: 5n, logIndex: 0n });
  });

  test("encodes the stationId probe and decodes its uint64 answer", () => {
    const station = "0x2222222222222222222222222222222222222222";
    expect(stationIdCalldata(station)).toBe(`0x0d65e3a4${"0".repeat(24)}${station.slice(2)}`);
    expect(parseStationId(`0x${"0".repeat(63)}7`)).toBe(7n);
    expect(parseStationId(`0x${"0".repeat(64)}`)).toBe(0n);
    expect(() => parseStationId(`0x${"f".repeat(64)}`)).toThrow("exceeds uint64");
    expect(() => parseStationId("0x")).toThrow("exactly 32 bytes");
  });

  test("rejects StationMinted events carrying unexpected data", () => {
    const log: RpcLog = {
      address: "0x4444444444444444444444444444444444444444",
      topics: [
        STATION_MINTED_TOPIC,
        topicUint(3n),
        topicAddress("0x2222222222222222222222222222222222222222"),
        topicAddress("0x3333333333333333333333333333333333333333"),
      ],
      data: `0x${"aa".repeat(32)}`,
      blockNumber: "0x5",
      logIndex: "0x0",
    };
    expect(() => parseStationMinted(log)).toThrow("StationMinted data must be exactly 0 bytes");
  });
});
