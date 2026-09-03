import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const webRoot = `${import.meta.dir}/../..`;

describe("tuner image", () => {
  test("build stage copies every config the build script runs", () => {
    const dockerfile = readFileSync(`${webRoot}/Dockerfile`, "utf8");
    const buildStage = dockerfile.split(/^FROM .* AS runtime$/m)[0];
    const copied = new Set(
      buildStage
        .split("\n")
        .filter((line) => line.startsWith("COPY "))
        .flatMap((line) => line.slice(5).trim().split(/\s+/).slice(0, -1)),
    );
    const build = JSON.parse(readFileSync(`${webRoot}/package.json`, "utf8")).scripts.build as string;
    const configs = ["vite.config.ts", ...Array.from(build.matchAll(/-c\s+(\S+)/g), (match) => match[1])];
    expect(configs.length).toBeGreaterThan(1);
    for (const config of configs) expect(copied).toContain(config);
  });
});
