import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chromeCdpBaseUrl,
  parseTweetRows,
  parseXueqiuQuote,
  twitterSearchUrl,
  xueqiuStockUrl
} from "../src/trade/chrome-cdp.js";

test("chromeCdpBaseUrl defaults to local debug port", () => {
  const prev = process.env.KING_AI_CHROME_CDP_URL;
  delete process.env.KING_AI_CHROME_CDP_URL;
  assert.equal(chromeCdpBaseUrl(), "http://127.0.0.1:9222");
  process.env.KING_AI_CHROME_CDP_URL = prev;
});

test("twitterSearchUrl encodes query", () => {
  const url = twitterSearchUrl("from:elonmusk");
  assert.ok(url.includes("from%3Aelonmusk"));
  assert.ok(url.includes("f=live"));
});

test("xueqiuStockUrl preserves A-share symbols", () => {
  assert.equal(xueqiuStockUrl("SH000001"), "https://xueqiu.com/S/SH000001");
});

test("parseTweetRows accepts arrays and JSON strings", () => {
  const rows = parseTweetRows('[{"id":"1","text":"hi"}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "1");
});

test("parseXueqiuQuote normalizes price and change", () => {
  const row = parseXueqiuQuote({ price: 12.3, change_pct: -1.5 });
  assert.ok(row);
  assert.equal(row!.price, 12.3);
  assert.equal(row!.change_pct, -1.5);
});
