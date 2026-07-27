import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterWatchlist,
  formatStockPrice,
  formatStocksSectionLines,
  isStockMover,
  stockMoveThreshold,
  type StockQuoteRow,
} from "../src/trade/morning-brief-stocks.js";

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

describe("stock movers layout", () => {
  const rows: StockQuoteRow[] = [
    { symbol: "TSLA", name: "特斯拉", price: 320, changePct: -14.5, marketTime: null, threshold: 5 },
    { symbol: "NVDA", name: "英伟达", price: 200, changePct: -1.5, marketTime: null, threshold: 5 },
    { symbol: "AAPL", name: "苹果", price: 300, changePct: -0.8, marketTime: null, threshold: 5 },
    { symbol: "GLD", name: "黄金ETF", price: 370, changePct: -2.0, marketTime: null, threshold: 3 },
    { symbol: "CRCL", name: "Circle", price: 62, changePct: -6.0, marketTime: null, threshold: 5 },
    { symbol: "BAD", name: "失败", price: null, changePct: null, marketTime: null, threshold: 5 },
  ];

  it("uses tighter thresholds for index/ETF symbols", () => {
    assert.equal(stockMoveThreshold("TSLA"), 5);
    assert.equal(stockMoveThreshold("GLD"), 3);
    assert.equal(stockMoveThreshold("SH000001"), 3);
    assert.equal(isStockMover(rows[0]!), true);
    assert.equal(isStockMover(rows[1]!), false);
  });

  it("lists movers by absolute move and folds quiet names", () => {
    const text = formatStocksSectionLines(rows).join("\n");
    assert.match(text, /特斯拉\(TSLA\): \$320\.00 \(-14\.50%\)/);
    assert.match(text, /Circle\(CRCL\): \$62\.00 \(-6\.00%\)/);
    assert.ok(text.includes("⚠️"));
    assert.ok(text.indexOf("TSLA") < text.indexOf("CRCL"), "larger |Δ| first");
    assert.match(text, /其余 3 只未达阈值/);
    assert.match(text, /报价失败: BAD/);
    assert.doesNotMatch(text, /英伟达\(NVDA\): \$200/);
  });

  it("falls back to relative actives when nothing crosses the threshold", () => {
    const quietOnly: StockQuoteRow[] = [
      { symbol: "AAPL", name: "苹果", price: 300, changePct: 1.2, marketTime: null, threshold: 5 },
      { symbol: "NVDA", name: "英伟达", price: 200, changePct: -2.1, marketTime: null, threshold: 5 },
      { symbol: "PDD", name: "拼多多", price: 80, changePct: 0.3, marketTime: null, threshold: 5 },
    ];
    const text = formatStocksSectionLines(quietOnly).join("\n");
    assert.match(text, /均未达异动阈值/);
    assert.match(text, /英伟达\(NVDA\)/);
    assert.match(text, /苹果\(AAPL\)/);
  });

  it("can still dump the full watchlist when showAll is set", () => {
    const text = formatStocksSectionLines(rows, { showAll: true }).join("\n");
    assert.match(text, /英伟达\(NVDA\)/);
    assert.match(text, /苹果\(AAPL\)/);
    assert.doesNotMatch(text, /其余 .* 只未达阈值/);
  });
});
