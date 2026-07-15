import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterWatchlist, formatStockPrice } from "../src/trade/morning-brief-stocks.js";

describe("formatStockPrice", () => {
  it("formats A-share indices as points", () => {
    assert.equal(formatStockPrice("SH000001", 3955.58), "3955.58");
    assert.equal(formatStockPrice("SZ399001", 12634.41), "12634.41");
  });

  it("formats Hong Kong and US symbols with their currencies", () => {
    assert.equal(formatStockPrice("01810", 25.86), "HK$25.86");
    assert.equal(formatStockPrice("NVDA", 173.42), "$173.42");
  });
});

describe("filterWatchlist", () => {
  it("excludes symbols case-insensitively and keeps entry order", () => {
    const filtered = filterWatchlist({ TLT: "20+年美债ETF", NVDA: "英伟达", gld: "黄金ETF", TSLA: "特斯拉" }, [
      "tlt",
      "GLD",
    ]);
    assert.deepEqual(filtered, { NVDA: "英伟达", TSLA: "特斯拉" });
    assert.deepEqual(Object.keys(filtered), ["NVDA", "TSLA"]);
  });
});
