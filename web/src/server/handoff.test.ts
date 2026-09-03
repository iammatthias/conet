import { describe, expect, test } from "bun:test";

const page = await Bun.file(new URL("../../index.html", import.meta.url)).text();

function promptText(): string {
  const match = /<pre id="agent-prompt"[^>]*>\n?([\s\S]*?)<\/pre>/.exec(page);
  if (!match?.[1]) throw new Error("index.html has no agent prompt");
  return match[1];
}

describe("the hand-off prompt", () => {
  test("copies exactly what is shown, with no whitespace beyond the last sentence", () => {
    const text = promptText();
    expect(text).toBe(text.trim());
    expect(text.endsWith(".")).toBe(true);
  });

  test("sends the agent to the served skill on the same origin", () => {
    expect(promptText().startsWith("Fetch {origin}/skill.md")).toBe(true);
  });
});
