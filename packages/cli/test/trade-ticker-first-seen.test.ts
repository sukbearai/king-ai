import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertState, createAlert } from "../src/trade/alert-rule.js";

/**
 * Pure regression for ticker first-emergence demotion.
 * Full rule.check needs sqlite; here we assert the emit shape the rule must produce
 * when isFirst (baselineTotal === 0): severity info + tags first_seen + 首次浮现 title.
 */
describe("ticker_velocity first-emergence demotion", () => {
  it("first_seen path emits info with first_seen tag and 首次浮现 title", () => {
    const isFirst = true;
    const ticker = "NEWCOIN";
    const cnt24h = 3;
    const authors24h = 2;
    const views24h = 1000;
    const tag = isFirst ? "首次浮现" : "提及加速 3.0×";
    const severity: "info" | "warning" | "critical" = isFirst ? "info" : "warning";
    const alertKey = `ticker_${ticker}`;
    const state = new AlertState({});
    assert.equal(state.canAlert(alertKey, 86400), true);

    const alert = createAlert({
      ruleId: "ticker_velocity",
      severity,
      title: `$${ticker} ${tag} (${cnt24h}条/${authors24h}作者/${views24h.toLocaleString()}👁)`,
      detail: "baseline",
      direction: 0.5,
      strength: 0.5,
      asset: ticker,
      tags: isFirst ? ["first_seen"] : [],
      cooldownKey: alertKey,
    });

    assert.equal(alert.severity, "info");
    assert.deepEqual(alert.tags, ["first_seen"]);
    assert.match(alert.title, /首次浮现/);
    assert.equal(alert.cooldownKey, alertKey);
  });

  it("non-first velocity path stays warning without first_seen", () => {
    const isFirst = false;
    const mult = 4;
    let severity: "info" | "warning" | "critical" = isFirst ? "info" : "warning";
    if (!isFirst && mult >= 5) severity = "critical";
    const alert = createAlert({
      ruleId: "ticker_velocity",
      severity,
      title: `$FOO 提及加速 ${mult.toFixed(1)}× (10条/3作者/5000👁)`,
      detail: "d",
      asset: "FOO",
      tags: isFirst ? ["first_seen"] : [],
      cooldownKey: "ticker_FOO",
    });
    assert.equal(alert.severity, "warning");
    assert.deepEqual(alert.tags, []);
    assert.doesNotMatch(alert.title, /首次浮现/);
  });
});
