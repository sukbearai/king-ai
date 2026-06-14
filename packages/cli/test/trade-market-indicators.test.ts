import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calcRsi } from "../src/trade/market-indicators.js";

describe("calcRsi", () => {
  it("returns neutral when insufficient data", () => {
    assert.equal(calcRsi([1, 2, 3]), 50);
  });

  it("returns high rsi for steady uptrend", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    assert.ok(calcRsi(closes) > 70);
  });
});