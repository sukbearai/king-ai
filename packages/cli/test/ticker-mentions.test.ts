import assert from "node:assert/strict";
import { test } from "node:test";
import { textHash } from "../src/trade/ticker-mentions.js";

test("textHash is stable short md5 prefix", () => {
  const a = textHash("hello $BTC world");
  const b = textHash("hello $BTC world");
  assert.equal(a, b);
  assert.equal(a.length, 12);
});
