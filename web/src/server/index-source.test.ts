import { afterAll, describe, expect, test } from "bun:test";
import { createIndexSource } from "./index-source";

const station = "0x1111111111111111111111111111111111111111";
const creator = "0x2222222222222222222222222222222222222222";
const writer = "0x3333333333333333333333333333333333333333";
const cursor = { block: 100n, logIndex: -1n };

function stationRow(id: number, blockNumber: number, logIndex: number) {
  return { stationId: id, address: station, creator, blockNumber, logIndex };
}

function transmissionRow(seq: number, blockNumber: number, logIndex: number) {
  return { seq, nonce: "0000000000000007", writer, kind: 1, cipher: "0102", blockNumber, logIndex, transactionHash: `0x${"ab".repeat(32)}` };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const healthy = () => json({ transmissions: [transmissionRow(1, 130, 0)], cursor: "130:0", scannedThrough: 500 });

let respond: (url: URL) => Response = () => json({});
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    requests.push(`${url.pathname}${url.search}`);
    return respond(url);
  },
});
const source = () => createIndexSource(`http://127.0.0.1:${server.port}`);

afterAll(() => server.stop(true));

describe("index-backed paging advances like the RPC path", () => {
  test("a short page moves the cursor past the indexed head so the receiver can tune", async () => {
    respond = () => json({ stations: [stationRow(1, 120, 3)], cursor: "120:3", scannedThrough: 500, highestStationId: 1 });
    const page = await source().stations(cursor, 100);
    expect(page?.values.map((mint) => mint.stationId)).toEqual([1n]);
    expect(page?.cursor).toEqual({ block: 501n, logIndex: -1n });
    expect(page?.head).toBe(500n);
    expect(page?.highestStationId).toBe(1n);
  });

  test("a full page keeps the last row as the cursor", async () => {
    respond = () => json({
      transmissions: [transmissionRow(1, 130, 0), transmissionRow(2, 131, 4)],
      cursor: "131:4",
      scannedThrough: 500,
    });
    const page = await source().transmissions(station, cursor, 2);
    expect(page?.values.map((heard) => heard.seq)).toEqual([1n, 2n]);
    expect(page?.values[0]?.writer).toBe(writer);
    expect(page?.cursor).toEqual({ block: 131n, logIndex: 4n });
  });
});

describe("the index yields to RPC whenever it cannot answer exactly", () => {
  test("an index behind the requested cursor yields without opening the cooldown", async () => {
    const index = source();
    respond = () => json({ transmissions: [], cursor: "700:-1", scannedThrough: 500 });
    expect(await index.transmissions(station, { block: 700n, logIndex: -1n }, 100)).toBeUndefined();
    respond = () => json({ stations: [], cursor: "700:-1", scannedThrough: 500 });
    expect(await index.stations({ block: 700n, logIndex: -1n }, 100)).toBeUndefined();

    respond = healthy;
    expect((await index.transmissions(station, cursor, 100))?.values).toHaveLength(1);
  });

  test("an index that has scanned exactly the cursor block answers", async () => {
    respond = () => json({ transmissions: [], cursor: "500:-1", scannedThrough: 500 });
    const page = await source().transmissions(station, { block: 500n, logIndex: -1n }, 100);
    expect(page?.values).toEqual([]);
    expect(page?.cursor).toEqual({ block: 501n, logIndex: -1n });
  });

  test("a Station the index has not seen yields without opening the cooldown", async () => {
    const index = source();
    respond = () => json({ error: "station not indexed" }, 404);
    expect(await index.transmissions(station, cursor, 100)).toBeUndefined();
    expect(await index.station(station)).toBeUndefined();

    respond = healthy;
    expect((await index.transmissions(station, cursor, 100))?.values).toHaveLength(1);
  });

  test("a failing index yields and opens the cooldown", async () => {
    const index = source();
    respond = () => json({ error: "boom" }, 500);
    expect(await index.transmissions(station, cursor, 100)).toBeUndefined();

    respond = healthy;
    const served = requests.length;
    expect(await index.transmissions(station, cursor, 100)).toBeUndefined();
    expect(requests.length).toBe(served);
  });

  test("a malformed 200 yields and opens the cooldown", async () => {
    const page = (transmissions: unknown[], extra: Record<string, unknown> = {}) =>
      ({ transmissions, cursor: "130:0", scannedThrough: 500, ...extra });
    const malformed: unknown[] = [
      null,
      [],
      { transmissions: "none", cursor: "130:0", scannedThrough: 500 },
      page([], { scannedThrough: "500" }),
      page([], { scannedThrough: 1.5 }),
      page([], { cursor: "latest" }),
      page([{ ...transmissionRow(1, 130, 0), writer: undefined }]),
      page([{ ...transmissionRow(1, 130, 0), writer: writer.toUpperCase() }]),
      page([{ ...transmissionRow(1, 130, 0), cipher: "abc" }]),
      page([{ ...transmissionRow(1, 130, 0), cipher: "" }]),
      page([{ ...transmissionRow(1, 130, 0), seq: 0 }]),
      page([{ ...transmissionRow(1, 130, 0), seq: "1" }]),
      page([{ ...transmissionRow(1, 130, 0), nonce: "xyz" }]),
      page([{ ...transmissionRow(1, 130, 0), kind: 256 }]),
      page([{ ...transmissionRow(1, 130, 0), blockNumber: -1 }]),
      page([{ ...transmissionRow(1, 130, 0), transactionHash: "0xab" }]),
      { stations: [{ ...stationRow(1, 120, 3), address: "0x1" }], cursor: "120:3", scannedThrough: 500 },
      { stations: [stationRow(0, 120, 3)], cursor: "120:3", scannedThrough: 500 },
      { stations: [], cursor: "0:-1", scannedThrough: 500, highestStationId: "1" },
    ];
    for (const body of malformed) {
      const index = source();
      respond = () => json(body);
      const ask = () => "stations" in Object(body)
        ? index.stations(cursor, 100)
        : index.transmissions(station, cursor, 100);
      expect(await ask()).toBeUndefined();

      respond = healthy;
      const served = requests.length;
      expect(await index.transmissions(station, cursor, 100)).toBeUndefined();
      expect(requests.length).toBe(served);
    }
  });

  test("a body that is not JSON yields and opens the cooldown", async () => {
    const index = source();
    respond = () => new Response("<html>", { status: 200 });
    expect(await index.stations(cursor, 100)).toBeUndefined();

    respond = healthy;
    const served = requests.length;
    expect(await index.transmissions(station, cursor, 100)).toBeUndefined();
    expect(requests.length).toBe(served);
  });
});

describe("station lookup", () => {
  test("reads the Station record from its transmissions route", async () => {
    respond = () => json({ station: stationRow(3, 120, 2), transmissions: [], cursor: "0:-1", scannedThrough: 500 });
    expect(await source().station(station)).toEqual({
      stationId: 3n,
      station,
      creator,
      blockNumber: 120n,
      logIndex: 2n,
    });
    expect(requests.at(-1)).toBe(`/stations/${station}/transmissions?limit=1`);
  });

  test("a malformed Station record yields and opens the cooldown", async () => {
    const index = source();
    respond = () => json({ station: { ...stationRow(3, 120, 2), blockNumber: "120" }, transmissions: [], cursor: "0:-1", scannedThrough: 500 });
    expect(await index.station(station)).toBeUndefined();

    respond = healthy;
    const served = requests.length;
    expect(await index.transmissions(station, cursor, 100)).toBeUndefined();
    expect(requests.length).toBe(served);
  });
});
