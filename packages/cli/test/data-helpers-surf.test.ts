import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripAnsi } from "../src/trade/data-helpers.js";

describe("stripAnsi", () => {
  it("removes ANSI color codes from surf CLI output", () => {
    const colored = "\x1b[38;5;247m{\x1b[0m\n  \x1b[38;5;74m\"data\"\x1b[0m: []\n\x1b[38;5;247m}\x1b[0m";
    const plain = stripAnsi(colored);
    assert.equal(plain.includes("\x1b"), false);
    assert.doesNotThrow(() => JSON.parse(plain));
  });
});