import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactSummaryFallback } from "../src/trade/llm-summarize.js";
import { parseTelegramChannels, parseTgRecentMessages } from "../src/trade/morning-brief.js";
import { chunkTelegramMessage } from "../src/trade/telegram.js";
import { countRecentCacheRecords } from "../src/trade/twitter-cache.js";

describe("parseTelegramChannels", () => {
  it("maps label to tg chat name", () => {
    const rows = parseTelegramChannels({
      "方程式快讯": "方程式新闻 BWEnews",
      "传统金融/宏观": "@BWETradFi |方程式财经（传统金融新闻）",
      "meme 链上监控": "meme链上监控"
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { label: "方程式快讯", chat: "方程式新闻 BWEnews" });
    assert.deepEqual(rows[2], { label: "meme 链上监控", chat: "meme链上监控" });
  });
});

describe("parseTgRecentMessages", () => {
  it("extracts content from tg recent --json output", () => {
    const raw = JSON.stringify({
      ok: true,
      data: [{ content: "hello" }, { content: "world" }, { content: "" }]
    });
    assert.deepEqual(parseTgRecentMessages(raw), ["hello", "world"]);
  });

  it("returns empty array for blank output", () => {
    assert.deepEqual(parseTgRecentMessages(""), []);
  });
});

describe("countRecentCacheRecords", () => {
  it("counts recent vs stale tweets from cache stats shape", async () => {
    const stats = await countRecentCacheRecords(24, "/nonexistent/twitter_cache.jsonl");
    assert.deepEqual(stats, { total: 0, recent: 0, stale: 0, invalid: 0 });
  });
});

describe("compactSummaryFallback", () => {
  it("deduplicates and caps raw text when local agents are unavailable", () => {
    const repeated = [
      "**BTC** breaks 60000",
      "BTC breaks 60000",
      "",
      "[ETH bid](https://example.com)",
      ...Array.from({ length: 30 }, (_, i) => `line ${i}`)
    ].join("\n");
    const out = compactSummaryFallback(repeated);
    assert.match(out, /BTC breaks 60000/);
    assert.match(out, /ETH bid/);
    assert.equal(out.includes("https://example.com"), false);
    assert.ok(out.split("\n").length <= 12);
    assert.ok(out.length <= 1400);
  });
});

describe("chunkTelegramMessage", () => {
  it("splits long brief text into Telegram-sized chunks", () => {
    const chunks = chunkTelegramMessage(["header", "x".repeat(4500)].join("\n\n"));
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  });
});
