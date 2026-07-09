import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { directionLabel, createAlert } from "../src/trade/alert-rule.js";
import { parseMemeTradeAmount } from "../src/trade/rules/rule-e-meme.js";
import {
  celebrityAlertSeverity,
  extractChainFmRefs,
  groundEntitiesInText,
  isCelebritySeenRecordActive,
  isLikelyTweetUiFragment,
  resolveCelebrityAlphaDecision,
} from "../src/trade/rules/rule-t-celebrity.js";
import { buildPanewsUnclassifiedAlert } from "../src/trade/rules/rule-q-panews.js";
import { createRule, listRuleIds } from "../src/trade/rules/registry.js";

describe("parseMemeTradeAmount", () => {
  it("parses K/M suffix amounts", () => {
    assert.equal(parseMemeTradeAmount("1.5K"), 1500);
    assert.equal(parseMemeTradeAmount("2M"), 2_000_000);
    assert.equal(parseMemeTradeAmount("$3,500"), 3500);
  });
});

describe("buildPanewsUnclassifiedAlert", () => {
  it("creates info alert with desc or fallback detail", () => {
    const withDesc = buildPanewsUnclassifiedAlert({ title: "Test", desc: "body" });
    assert.equal(withDesc.severity, "info");
    assert.equal(withDesc.title, "Test");
    assert.match(withDesc.detail, /body/);

    const bare = buildPanewsUnclassifiedAlert({ title: "Only title" });
    assert.match(bare.detail, /agent 分类暂不可用/);
  });
});

describe("directionLabel", () => {
  it("uses direction field when set", () => {
    assert.equal(
      directionLabel(
        createAlert({
          ruleId: "stocks",
          severity: "info",
          title: "t",
          detail: "d",
          direction: -1,
        }),
      ),
      "跌破",
    );
    assert.equal(
      directionLabel(
        createAlert({
          ruleId: "stocks",
          severity: "info",
          title: "t",
          detail: "d",
          direction: 1,
        }),
      ),
      "突破",
    );
  });
});

describe("celebrity rule helpers", () => {
  it("extracts chain.fm refs from tweet text", () => {
    const text = "Check https://chain.fm/token/solana/AbC123 and https://chain.fm/token/bsc/0xdead";
    const refs = extractChainFmRefs(text);
    assert.equal(refs.length, 2);
    assert.equal(refs[0]!.chain, "solana");
    assert.equal(refs[0]!.address, "AbC123");
    assert.match(refs[0]!.url, /chain\.fm\/token\/solana\/AbC123/);
  });

  it("maps alpha type, entity count, and confidence to severity autonomously", () => {
    assert.equal(celebrityAlertSeverity("endorsement", 1, 0.9), "warning");
    assert.equal(celebrityAlertSeverity("endorsement", 1, 0.5), "info");
    assert.equal(celebrityAlertSeverity("naming", 3, 0.8), "warning");
    assert.equal(celebrityAlertSeverity("naming", 1, 0.95), "warning");
    assert.equal(celebrityAlertSeverity("naming", 1, 0.8), "info");
  });

  it("grounds entities in tweet text and drops hallucinations", () => {
    const { kept, dropped } = groundEntitiesInText("Just bought $PEPE and DOGE forever", [
      "PEPE",
      "DOGE",
      "BONK",
      "AI",
    ]);
    assert.deepEqual(kept, ["PEPE", "DOGE"]);
    assert.ok(dropped.includes("BONK"));
    assert.ok(dropped.includes("AI"));
  });

  it("resolveCelebrityAlphaDecision keeps LLM autonomy with ledger rails only", () => {
    const ok = resolveCelebrityAlphaDecision(
      {
        is_alpha: true,
        alpha_type: "endorsement",
        confidence: 0.88,
        reason: "点名买入",
        entities: ["PEPE", "FAKE"],
      },
      "Elon says buy $PEPE now",
    );
    assert.equal(ok.meta.is_alpha, true);
    assert.deepEqual(ok.entities, ["PEPE"]);
    assert.ok(ok.meta.grounded_out?.includes("FAKE"));

    const lowConf = resolveCelebrityAlphaDecision(
      { is_alpha: true, alpha_type: "naming", confidence: 0.2, reason: "maybe", entities: ["PEPE"] },
      "love $PEPE",
    );
    assert.equal(lowConf.meta.is_alpha, false);

    const noEntity = resolveCelebrityAlphaDecision(
      { is_alpha: true, alpha_type: "policy", confidence: 0.9, reason: "监管", entities: [] },
      "crypto needs clarity",
    );
    assert.equal(noEntity.meta.is_alpha, false);

    const parseFail = resolveCelebrityAlphaDecision(null, "x");
    assert.equal(parseFail.meta.parse_failed, true);
  });

  it("filters browser UI fragments before LLM extraction", () => {
    assert.equal(
      isLikelyTweetUiFragment(
        `Donald J. Trump
@realDonaldTrump
·
May 23
0:20
72K
112K
909K
99M`,
        "realDonaldTrump",
      ),
      true,
    );
    assert.equal(isLikelyTweetUiFragment("Launching a new token today on Solana", "realDonaldTrump"), false);
  });

  it("expires non-alpha seen records sooner than terminal records", () => {
    const now = 10_000;
    assert.equal(isCelebritySeenRecordActive({ id: "tweet-1", ts: now - 3600, ttl_seconds: 7200 }, now), true);
    assert.equal(isCelebritySeenRecordActive({ id: "tweet-1", ts: now - 7201, ttl_seconds: 7200 }, now), false);
    assert.equal(isCelebritySeenRecordActive({ id: "tweet-2", ts: now - 2 * 86400 }, now), true);
    assert.equal(isCelebritySeenRecordActive({ id: "tweet-2", ts: now - 4 * 86400 }, now), false);
  });
});

describe("slim registry", () => {
  it("loads every listed rule id", () => {
    for (const id of listRuleIds()) {
      assert.ok(createRule(id), `slim rule ${id}`);
    }
  });
});
