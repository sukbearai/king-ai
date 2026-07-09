import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactSummaryFallback } from "../src/trade/llm-summarize.js";
import {
  parseTelegramChannels,
  parseTgRecentMessages,
  preprocessTelegramBody,
  formatTwitterSummaryHeading,
  isTradeRelevantTweet,
  resolveBriefingPushTg,
} from "../src/trade/morning-brief.js";
import { chunkTelegramMessage } from "../src/trade/telegram.js";
import { countRecentCacheRecords } from "../src/trade/twitter-cache.js";

describe("parseTelegramChannels", () => {
  it("maps label to tg chat name", () => {
    const rows = parseTelegramChannels({
      方程式快讯: "方程式新闻 BWEnews",
      "传统金融/宏观": "@BWETradFi |方程式财经（传统金融新闻）",
      "meme 链上监控": "meme链上监控",
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
      data: [{ content: "hello" }, { content: "world" }, { content: "" }],
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

describe("preprocessTelegramBody", () => {
  it("deduplicates meme transfer spam and strips markdown links", () => {
    const raw = [
      "⬇️ [CZ](https://chain.fm/account) received 200k Fomo3D from 0xce...25c6",
      "⬇️ [CZ](https://chain.fm/account) received 200k Fomo3D from 0xce...25c6",
      "⚙️",
      "⬇️ [CZ](https://chain.fm/account) received 100k Fomo3D from 0xb0...ea61",
    ].join("\n");
    const out = preprocessTelegramBody(raw);
    assert.equal(out.split("\n").length, 2);
    assert.match(out, /CZ.*received 200k Fomo3D/);
    assert.equal(out.includes("https://"), false);
  });
});

describe("resolveBriefingPushTg", () => {
  it("prefers explicit CLI flag over config", () => {
    const config = { briefing: { push_telegram: true } };
    assert.equal(resolveBriefingPushTg(config, { pushTg: false }), false);
    assert.equal(resolveBriefingPushTg(config, { pushTg: true }), true);
  });

  it("falls back to briefing.push_telegram when flag is unset", () => {
    assert.equal(resolveBriefingPushTg({ briefing: { push_telegram: true } }), true);
    assert.equal(resolveBriefingPushTg({ briefing: { push_telegram: false } }), false);
    assert.equal(resolveBriefingPushTg({}), false);
  });
});

describe("formatTwitterSummaryHeading", () => {
  it("includes the displayed tweet count when available", () => {
    assert.equal(formatTwitterSummaryHeading(24, 17), "🐦 Twitter 时间线（最近 24h，共 17 条推文）\n");
    assert.equal(formatTwitterSummaryHeading(24, 0), "🐦 Twitter 时间线（最近 24h，共 0 条推文）\n");
  });

  it("keeps the legacy heading shape when count is unknown", () => {
    assert.equal(formatTwitterSummaryHeading(24), "🐦 Twitter 时间线（最近 24h）\n");
  });
});

describe("isTradeRelevantTweet", () => {
  it("keeps market and regulatory items", () => {
    assert.equal(isTradeRelevantTweet("证监会查实虚假信息扰乱证券市场，股票交易被暂停"), true);
    assert.equal(isTradeRelevantTweet("NVIDIA earnings beat expectations; AI chips revenue rises"), true);
    assert.equal(isTradeRelevantTweet("BTC突破64000美元，过去24小时全网合约爆仓扩大"), true);
  });

  it("filters low-value social noise", () => {
    assert.equal(isTradeRelevantTweet("比利时 4 比 1 击败美国，球员攻入世界杯首球"), false);
    assert.equal(isTradeRelevantTweet("HSBC Pulse卡内地消费返现4.4%，申卡攻略"), false);
    assert.equal(isTradeRelevantTweet("relayrouter.io 提供 Fable 5 账号池七折优惠"), false);
    assert.equal(isTradeRelevantTweet("OKX 推出世界杯竞猜活动，可赢取比特币奖励"), false);
    assert.equal(isTradeRelevantTweet("TradingBox AI 交易信号 7 天免费试用推广"), false);
    assert.equal(isTradeRelevantTweet("Juggling a football for a chance to earn Bitcoin rewards"), false);
    assert.equal(isTradeRelevantTweet("Fable can be used again until July 12th but my quota is gone"), false);
  });
});

describe("compactSummaryFallback", () => {
  it("deduplicates and caps raw text when local agents are unavailable", () => {
    const repeated = [
      "**BTC** breaks 60000",
      "BTC breaks 60000",
      "",
      "[ETH bid](https://example.com)",
      ...Array.from({ length: 30 }, (_, i) => `line ${i}`),
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
