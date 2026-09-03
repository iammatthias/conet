import { describe, expect, test } from "bun:test";
import { HEARD_TOPIC, STATION_MINTED_TOPIC, parseHeard, topicAddress, topicUint } from "./abi";
import { fiveFigureGroups } from "../numbers";

const skill = await Bun.file(new URL("../../public/skill.md", import.meta.url)).text();

function capture(pattern: RegExp): string {
  const match = pattern.exec(skill);
  if (!match?.[1]) throw new Error(`skill.md no longer matches ${pattern}`);
  return match[1];
}

interface AbiEntry {
  type: string;
  name?: string;
  inputs?: Array<{ name: string; type: string; indexed?: boolean }>;
}

async function servedAbi(name: string): Promise<AbiEntry[]> {
  return Bun.file(new URL(`../../public/abi/${name}.json`, import.meta.url)).json() as Promise<AbiEntry[]>;
}

describe("the served skill agrees with the tuner's parsers", () => {
  test("every Heard and StationMinted topic the skill prints is the parsers' topic", () => {
    expect(capture(/StationMinted topic0\s+(0x[0-9a-f]{64})/)).toBe(STATION_MINTED_TOPIC);
    expect(capture(/Heard topic0\s+(0x[0-9a-f]{64})/)).toBe(HEARD_TOPIC);
    expect(capture(/"topics": \["(0x[0-9a-f]{64})"\]/)).toBe(HEARD_TOPIC);
    expect(capture(/Vector 3[\s\S]*?topics\s+\[(0x[0-9a-f]{64}),/)).toBe(HEARD_TOPIC);
  });

  test("vector 3 decodes through parseHeard to vector 1's nonce and cipher", () => {
    const nonce = capture(/Vector 1[\s\S]*?nonce\s+([0-9a-f]{16})/);
    const cipher = capture(/Vector 1[\s\S]*?cipher\s+([0-9a-f]+)/);
    const data = `0x${capture(/Vector 3[\s\S]*?data\s+0x([0-9a-f\s]+?)\n\ndecodes to/).replace(/\s+/g, "")}`;

    const heard = parseHeard({
      address: `0x${"11".repeat(20)}`,
      topics: [HEARD_TOPIC, topicUint(1n), topicAddress(`0x${"22".repeat(20)}`)],
      data,
      blockNumber: "0x1",
      logIndex: "0x0",
    });

    expect(heard.nonce).toBe(BigInt(`0x${nonce}`));
    expect(heard.kind).toBe(1);
    expect(heard.cipher).toBe(cipher);
    expect(data.length).toBe(2 + 160 * 2);
  });

  test("the observer-encoding vectors match the tuner's codec", () => {
    const rows = [...skill.matchAll(/^cipher ([0-9a-f]+)\s+\((\d+) bytes\)\s+groups\s+(\d[\d ]*?)\s*$/gm)];
    expect(rows.length).toBe(3);
    for (const [, cipher, bytes, groups] of rows) {
      expect(cipher.length / 2).toBe(Number(bytes));
      expect(fiveFigureGroups(cipher).join(" ")).toBe(groups);
    }
  });

  test("vectors are numbered consecutively", () => {
    const numbers = [...skill.matchAll(/^Vector (\d+) —/gm)].map((match) => Number(match[1]));
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  test("the served ABI carries the event and registry surface the parsers and skill rely on", async () => {
    const conet = await servedAbi("Conet");
    const heard = conet.find((entry) => entry.type === "event" && entry.name === "Heard");
    expect(heard?.inputs?.map((input) => `${input.name}:${input.type}:${input.indexed}`)).toEqual([
      "seq:uint64:true",
      "writer:address:true",
      "nonce:uint64:false",
      "kind:uint8:false",
      "cipher:bytes:false",
    ]);

    const factory = await servedAbi("ConetFactory");
    const functions = factory.filter((entry) => entry.type === "function").map((entry) => entry.name);
    expect(functions).toEqual(["mint", "stationCount", "stationId", "target"]);
  });
});
