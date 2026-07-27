import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TICKER_VELOCITY_MIN_VIEWS, meetsTickerVelocityMinViews } from "../src/trade/rules/rule-t-ticker.js";

describe("ticker velocity min_views gate", () => {
  it("defaults absolute floor to 10000", () => {
    assert.equal(DEFAULT_TICKER_VELOCITY_MIN_VIEWS, 10_000);
  });

  it("rejects samples below the floor (e.g. 2376 views)", () => {
    assert.equal(meetsTickerVelocityMinViews(2_376), false);
    assert.equal(meetsTickerVelocityMinViews(9_999), false);
  });

  it("accepts samples at or above the floor", () => {
    assert.equal(meetsTickerVelocityMinViews(10_000), true);
    assert.equal(meetsTickerVelocityMinViews(50_000), true);
  });

  it("honors an explicit minViews override", () => {
    assert.equal(meetsTickerVelocityMinViews(500, 1000), false);
    assert.equal(meetsTickerVelocityMinViews(1500, 1000), true);
  });
});
