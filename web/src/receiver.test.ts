import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
    expect(page).toContain('<main id="receiver" tabindex="-1" data-explorer="{{explorerUrl}}"></main>');
    expect(receiverMarkup()).not.toContain("{{");
  });

  test("the address form is the only optional part", () => {
    const page = receiverMarkup();
    const embed = receiverMarkup({ tuneByAddress: false });
    expect(page).toContain('id="tune-form"');
    expect(embed).not.toContain('id="tune-form"');
    expect(embed).not.toContain('id="station-address"');
    expect(page.replace(/<form id="tune-form"[\s\S]*?<\/form>\n?/, "").replace(/\s+/g, " ")).toBe(embed.replace(/\s+/g, " "));
  });

  test("the embed pins no explorer and takes the one the factory fragment carries", () => {
    const embed = readFileSync(`${import.meta.dir}/embed.ts`, "utf8");
    expect(embed).not.toMatch(/explorerUrl|basescan|etherscan/);
    const receiver = readFileSync(`${import.meta.dir}/receiver.ts`, "utf8");
    expect(receiver).toContain("dataset.explorer");
  });
});
