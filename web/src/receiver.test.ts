import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chainId, receiverSearch, tunerChains, tunerPath } from "./receiver-location";
import { receiverMarkup } from "./receiver-markup";

describe("receiver markup", () => {
  test("carries every element the receiver mounts against", () => {
    const source = readFileSync(`${import.meta.dir}/receiver.ts`, "utf8");
    const required = Array.from(source.matchAll(/element<[^>]+>\("([a-z-]+)"\)/g), (match) => match[1]);
    expect(required.length).toBeGreaterThan(10);
    for (const id of required) expect(receiverMarkup()).toContain(`id="${id}"`);
  });

  test("is the same receiver the page renders", () => {
    const page = readFileSync(`${import.meta.dir}/../index.html`, "utf8");
    expect(page.replace(/\s+/g, " ")).toContain('<main id="receiver" tabindex="-1" data-explorer="{{explorerUrl}}" data-chain="{{chainId}}" data-chains="{{tunerChains}}" ></main>');
    expect(receiverMarkup()).not.toContain("{{");
  });

  test("the chain picker and address form are the only optional parts, and they lead the receiver", () => {
    const page = receiverMarkup();
    const embed = receiverMarkup({ chainSelector: false, tuneByAddress: false });
    expect(page.indexOf('id="chain-select"')).toBeLessThan(page.indexOf('id="tune-form"'));
    expect(page.indexOf('id="tune-form"')).toBeLessThan(page.indexOf('id="frequency-dial"'));
    expect(page).toContain('<label for="chain-select">Chain</label>');
    expect(embed).not.toContain('id="chain-select"');
    expect(embed).not.toContain('id="tune-form"');
    expect(embed).not.toContain('id="station-address"');
    const withoutControls = page.replace(/<div class="receiver-controls[\s\S]*?<\/form>\n?<\/div>/, "");
    expect(withoutControls.replace(/\s+/g, " ")).toBe(embed.replace(/\s+/g, " "));
  });

  test("the embed pins no explorer and takes the one the factory fragment carries", () => {
    const embed = readFileSync(`${import.meta.dir}/embed.ts`, "utf8");
    expect(embed).not.toMatch(/explorerUrl|basescan|etherscan/);
    const receiver = readFileSync(`${import.meta.dir}/receiver.ts`, "utf8");
    expect(receiver).toContain("dataset.explorer");
  });
});

describe("receiver location", () => {
  const station = "0x1111111111111111111111111111111111111111";

  test("every tuner fetch names the selected chain", () => {
    expect(tunerPath("/_tuner/factory/stations", 4663, { limit: "1000", cursor: "" }))
      .toBe("/_tuner/factory/stations?chain=4663&limit=1000");
    expect(tunerPath(`/_tuner/stations/${station}/transmissions`, 1, { limit: "80", cursor: "26113629:-1" }))
      .toBe(`/_tuner/stations/${station}/transmissions?chain=1&limit=80&cursor=26113629%3A-1`);
    expect(tunerPath("/_tuner/factory/stations", undefined, { limit: "1000" }))
      .toBe("/_tuner/factory/stations?limit=1000");
  });

  test("the address bar carries the chain and Station, omitting the primary chain", () => {
    expect(receiverSearch("", { chain: 4663, primaryChain: 8453, station })).toBe(`?chain=4663&station=${station}`);
    expect(receiverSearch("?chain=4663&station=0xold", { chain: 8453, primaryChain: 8453, station }))
      .toBe(`?station=${station}`);
    expect(receiverSearch(`?utm=x&chain=1&station=${station}`, { chain: 1, primaryChain: 8453, station: "" }))
      .toBe("?utm=x&chain=1");
    expect(receiverSearch(`?station=${station}`, { chain: 8453, primaryChain: 8453, station: "" })).toBe("");
  });

  test("the page reads only well-formed chains from the server's list", () => {
    const raw = JSON.stringify([
      { chainId: 8453, name: "Base", explorer: "https://basescan.org" },
      { chainId: 4663, name: "Robinhood Chain", explorer: "javascript:alert(1)" },
      { chainId: "1", name: "Ethereum" },
      { chainId: 1 },
    ]);
    expect(tunerChains(raw)).toEqual([
      { chainId: 8453, name: "Base", explorer: "https://basescan.org" },
      { chainId: 4663, name: "Robinhood Chain", explorer: undefined },
    ]);
    expect(tunerChains("{{tunerChains}}")).toEqual([]);
    expect(tunerChains(undefined)).toEqual([]);
  });

  test("a chain id is a positive decimal integer or nothing", () => {
    expect(chainId("4663")).toBe(4663);
    expect(chainId("0")).toBeUndefined();
    expect(chainId("0x1")).toBeUndefined();
    expect(chainId("1e3")).toBeUndefined();
    expect(chainId(null)).toBeUndefined();
  });
});
