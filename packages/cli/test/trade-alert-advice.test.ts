import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTradeAlertAdvicePrompt,
  generateTradeAlertAdvice,
  parseTradeAlertAdvice,
  tradeAlertAdviceEnabled,
} from "../src/trade/alert-advice.js";
import { buildTgAlertItems, createAlert } from "../src/trade/alert-rule.js";

const warning = createAlert({
  ruleId: "stocks",
  severity: "warning",
  title: "NVDA 日内跌幅达到 6%",
  detail: "当前跌幅 -6.0%，触发 5% 阈值",
  asset: "NVDA",
  direction: -1,
  strength: 0.7,
  tags: ["equities"],
});

describe("trade alert LLM advice", () => {
  it("is opt-in through the global alert config", () => {
    assert.equal(tradeAlertAdviceEnabled({}), false);
    assert.equal(tradeAlertAdviceEnabled({ alerts: { llm_advice: true } }), true);
  });

  it("accepts summary-style guidance and rejects certainty language", async () => {
    const valid = JSON.stringify({
      take: "NVDA 跌破阈值，更像波动提醒，不代表趋势已经反转。",
      stance: "先观望或按计划减一点风险敞口，等量能和新闻面再决定是否回补。",
      watch: "盯住是否继续放量下跌，以及有无新的业绩/监管催化。",
    });
    assert.ok(parseTradeAlertAdvice(valid));
    assert.equal(
      parseTradeAlertAdvice(
        JSON.stringify({
          take: "建议立即买入抄底。",
          stance: "满仓干。",
        }),
      ),
      null,
    );

    const freeForm = parseTradeAlertAdvice(
      "美债收益率贴着阶段高点，风险资产更宜防守。\n\n仓位上先不追多，等收益率回落或股市放量确认再动手。",
    );
    assert.ok(freeForm);
    assert.match(freeForm!.take, /美债/);

    const prompts: string[] = [];
    const advice = await generateTradeAlertAdvice([warning], async (prompt) => {
      prompts.push(prompt);
      return valid;
    });
    assert.equal(advice.source, "llm");
    assert.match(advice.text, /投资备忘/);
    assert.match(advice.text, /NVDA 跌破阈值/);
    assert.doesNotMatch(advice.text, /可选行动/);
    assert.doesNotMatch(advice.text, /保守：/);
    assert.match(buildTradeAlertAdvicePrompt([warning]), /不得编造价格/);
    assert.match(buildTradeAlertAdvicePrompt([warning]), /NVDA/);
    assert.match(buildTradeAlertAdvicePrompt([warning]), /投资备忘|微信/);
    assert.equal(prompts.length, 1);
  });

  it("falls back to prose investment notes without a checklist framework", async () => {
    const advice = await generateTradeAlertAdvice([warning], async () => {
      throw new Error("agent unavailable");
    });
    assert.equal(advice.source, "fallback");
    assert.match(advice.text, /投资备忘/);
    assert.match(advice.text, /不构成个性化投资建议/);
    assert.doesNotMatch(advice.text, /可选行动|风险行动框架|保守：|中性：|激进：/);
  });

  it("appends one shared advice block for any rule and skips source-health alerts", async () => {
    let calls = 0;
    const items = await buildTgAlertItems([warning], { alerts: { llm_advice: true } }, async () => {
      calls += 1;
      return { text: "投资备忘\n\n先观望。", source: "llm" };
    });
    assert.equal(calls, 1);
    assert.equal(items.length, 2);
    assert.equal(items[1]!.format(), "投资备忘\n\n先观望。");

    const sourceHealth = createAlert({
      ruleId: "kimpremium",
      severity: "critical",
      title: "source unavailable",
      detail: "fetch failed",
      tags: ["source-health"],
    });
    const sourceItems = await buildTgAlertItems([sourceHealth], { alerts: { llm_advice: true } }, async () => {
      calls += 1;
      return { text: "must not run", source: "llm" };
    });
    assert.equal(calls, 1);
    assert.equal(sourceItems.length, 1);
  });

  it("keeps deterministic advice when the shared generator throws", async () => {
    const items = await buildTgAlertItems([warning], { alerts: { llm_advice: true } }, async () => {
      throw new Error("unexpected failure");
    });
    assert.equal(items.length, 2);
    assert.match(items[1]!.format(), /投资备忘/);
  });
});
