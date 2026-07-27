import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertState } from "../src/trade/alert-rule.js";
import {
  CELEBRITY_ENTITY_COOLDOWN_SECONDS,
  createCelebrityAlert,
  gateCelebrityTweetAlert,
  mergeCelebrityAccountTiers,
  mergeCelebrityAssetAliases,
  normalizeCelebrityAsset,
  resolveCelebrityAccountTier,
} from "../src/trade/rules/rule-t-celebrity.js";

describe("normalizeCelebrityAsset", () => {
  it("trims and strips 合约/股票/概念 suffixes", () => {
    const aliases = mergeCelebrityAssetAliases({});
    assert.equal(normalizeCelebrityAsset("  长鑫科技合约  ", aliases), "CXMT");
    assert.equal(normalizeCelebrityAsset("长鑫股票", aliases), "CXMT");
    assert.equal(normalizeCelebrityAsset("长鑫存储概念", aliases), "CXMT");
  });

  it("maps built-in Chinese aliases to CXMT", () => {
    const aliases = mergeCelebrityAssetAliases({});
    assert.equal(normalizeCelebrityAsset("长鑫科技", aliases), "CXMT");
    assert.equal(normalizeCelebrityAsset("长鑫", aliases), "CXMT");
    assert.equal(normalizeCelebrityAsset("长鑫存储", aliases), "CXMT");
  });

  it("lets config aliases override built-ins", () => {
    const aliases = mergeCelebrityAssetAliases({ 长鑫: "OTHER" });
    assert.equal(normalizeCelebrityAsset("长鑫", aliases), "OTHER");
  });

  it("uppercases bare ticker-like tokens", () => {
    assert.equal(normalizeCelebrityAsset("btc", {}), "BTC");
    assert.equal(normalizeCelebrityAsset("rk.lb", {}), "RK.LB");
  });

  it("returns cleaned raw when not alias and not ticker-like", () => {
    assert.equal(normalizeCelebrityAsset("某不知名公司", {}), "某不知名公司");
    assert.equal(normalizeCelebrityAsset("too-long-ticker-name", {}), "too-long-ticker-name");
  });
});

describe("celebrity entity cooldown gate", () => {
  it("emits first tweet then suppresses same account+entity within 4h while still gating markSeen path", () => {
    const state = new AlertState({});
    const asset = normalizeCelebrityAsset("长鑫科技合约", mergeCelebrityAssetAliases({}));
    assert.equal(asset, "CXMT");

    const first = gateCelebrityTweetAlert(state, "tid-1", "_FORAB", asset);
    assert.equal(first, "emit");

    // Different tweet, same account + normalized entity → entity cooldown blocks.
    const second = gateCelebrityTweetAlert(state, "tid-2", "_FORAB", asset);
    assert.equal(second, "skip_entity_cd");
    // Caller must markSeen on skip_entity_cd (rule does); gate itself does not emit.
    assert.equal(CELEBRITY_ENTITY_COOLDOWN_SECONDS, 14_400);

    // Different entity is still allowed.
    const other = gateCelebrityTweetAlert(state, "tid-3", "_FORAB", "PEPE");
    assert.equal(other, "emit");
  });

  it("suppresses duplicate tweet id via tweet cooldown", () => {
    const state = new AlertState({});
    assert.equal(gateCelebrityTweetAlert(state, "same", "elon", "DOGE"), "emit");
    assert.equal(gateCelebrityTweetAlert(state, "same", "elon", "DOGE"), "skip_tweet_cd");
  });
});

describe("celebrity news account tier", () => {
  it("defaults _FORAB to news and forces info + direction 0", () => {
    const tiers = mergeCelebrityAccountTiers({});
    assert.equal(resolveCelebrityAccountTier("_FORAB", tiers), "news");
    assert.equal(resolveCelebrityAccountTier("@_FORAB", tiers), "news");

    const alert = createCelebrityAlert({
      alphaType: "ipo",
      confidence: 0.9,
      severity: "info",
      title: "t",
      detail: "d",
      asset: "CXMT",
      tokenContract: "",
      tokenChain: "",
      tags: ["celebrity"],
      direction: 0,
    });
    assert.equal(alert.severity, "info");
    assert.equal(alert.direction, 0);
    assert.equal(alert.asset, "CXMT");
  });

  it("allows config to override account tier", () => {
    const tiers = mergeCelebrityAccountTiers({ _FORAB: "alpha" });
    assert.equal(resolveCelebrityAccountTier("_FORAB", tiers), "alpha");
  });
});
