import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripMarkdown } from "../src/trade/llm-summarize.js";

describe("stripMarkdown", () => {
  it("removes common markdown decorations", () => {
    const input = [
      "## Pump.fun 热榜",
      "",
      "**NTFS**：市值 $330M",
      "- TripleT +239%",
      "`9qNdHgJd`",
      "[官网](https://ntfs.world/)",
    ].join("\n");

    const out = stripMarkdown(input);
    assert.match(out, /Pump\.fun 热榜/);
    assert.doesNotMatch(out, /\*\*/);
    assert.doesNotMatch(out, /^##/m);
    assert.doesNotMatch(out, /`/);
    assert.match(out, /NTFS：市值 \$330M/);
    assert.match(out, /TripleT \+239%/);
    assert.match(out, /官网/);
    assert.doesNotMatch(out, /\[官网\]/);
  });

  it("unwraps fenced code blocks", () => {
    const out = stripMarkdown('```json\n{"ok":true}\n```');
    assert.equal(out, '{"ok":true}');
  });
});
