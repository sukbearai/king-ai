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

  it("accepts structured novice guidance and rejects certainty language", async () => {
    const valid = JSON.stringify({
      summary: "股票波动已超过预设阈值，但不能据此预测下一步方向。",
      actions: ["保守：等待", "中性：小额分批", "激进：限损且不用杠杆"],
      avoid: ["不要追涨杀跌、梭哈或满仓"],
      checks: ["复核下一条独立信号"],
    });
    assert.ok(parseTradeAlertAdvice(valid));
    assert.equal(parseTradeAlertAdvice(valid.replace("等待", "立即买入")), null);

    const prompts: string[] = [];
    const advice = await generateTradeAlertAdvice([warning], async (prompt) => {
      prompts.push(prompt);
      return valid;
    });
    assert.equal(advice.source, "llm");
    assert.match(advice.text, /保守：等待/);
    assert.match(buildTradeAlertAdvicePrompt([warning]), /不得补充实时行情/);
    assert.match(buildTradeAlertAdvicePrompt([warning]), /NVDA/);
    assert.equal(prompts.length, 1);
  });

  it("falls back without dropping the action framework", async () => {
    const advice = await generateTradeAlertAdvice([warning], async () => {
      throw new Error("agent unavailable");
    });
    assert.equal(advice.source, "fallback");
    assert.match(advice.text, /风险行动框架/);
    assert.match(advice.text, /不构成个性化投资建议/);
  });

  it("appends one shared advice block for any rule and skips source-health alerts", async () => {
    let calls = 0;
    const items = await buildTgAlertItems([warning], { alerts: { llm_advice: true } }, async () => {
      calls += 1;
      return { text: "LLM shared advice", source: "llm" };
    });
    assert.equal(calls, 1);
    assert.equal(items.length, 2);
    assert.equal(items[1]!.format(), "LLM shared advice");

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
    assert.match(items[1]!.format(), /本地回退/);
  });
});
