import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confluenceEnabled,
  confluenceWindowSeconds,
  enabledAlertRules,
  globalTickTimeoutMs,
  resolveCooldownConfig,
  SLIM_ALERT_RULES,
  TradeConfigError,
  validateTradeConfigShape,
} from "../src/trade/config.js";
import { normalizeRuleId } from "../src/trade/domain.js";

describe("enabledAlertRules", () => {
  it("defaults to slim stack when alerts.enabled missing", () => {
    assert.deepEqual(enabledAlertRules({}), [...SLIM_ALERT_RULES]);
  });

  it("respects explicit alerts.enabled and normalizes legacy ids", () => {
    assert.deepEqual(enabledAlertRules({ alerts: { enabled: ["q"] } }), ["panews"]);
    assert.deepEqual(enabledAlertRules({ alerts: { enabled: ["b", "treasury", "e"] } }), ["treasury", "meme_large"]);
  });

  it("skips unknown ids and reports them", () => {
    const unknown: string[] = [];
    assert.deepEqual(
      enabledAlertRules({ alerts: { enabled: ["nope", "stocks"] } }, { onUnknown: (id) => unknown.push(id) }),
      ["stocks"],
    );
    assert.deepEqual(unknown, ["nope"]);
  });
});

describe("fusion toggles", () => {
  it("confluence enabled by default and supports nested config", () => {
    assert.equal(confluenceEnabled({}), true);
    assert.equal(confluenceEnabled({ alerts: { confluence_enabled: false } }), false);
    assert.equal(confluenceEnabled({ alerts: { confluence: { enabled: false } } }), false);
    assert.equal(confluenceWindowSeconds({ alerts: { confluence: { window_seconds: 600 } } }), 600);
  });
});

describe("normalizeRuleId", () => {
  it("maps legacy and display names", () => {
    assert.equal(normalizeRuleId("b"), "treasury");
    assert.equal(normalizeRuleId("美债抛售"), "treasury");
    assert.equal(normalizeRuleId("celebrity"), "celebrity");
    assert.equal(normalizeRuleId("???"), null);
  });
});

describe("resolveCooldownConfig", () => {
  it("merges defaults with overrides for canonical and legacy keys", () => {
    const cd = resolveCooldownConfig({ alerts: { cooldowns: { b: 99, panews: 11 } } });
    assert.equal(cd.treasury, 99);
    assert.equal(cd.b, 99);
    assert.equal(cd.panews, 11);
  });
});

describe("globalTickTimeoutMs", () => {
  it("reads alerts.tick_timeout_ms", () => {
    assert.equal(globalTickTimeoutMs({}), null);
    assert.equal(globalTickTimeoutMs({ alerts: { tick_timeout_ms: 5000 } }), 5000);
  });
});

describe("validateTradeConfigShape", () => {
  it("warns on unknown enabled ids", () => {
    const warnings = validateTradeConfigShape({ alerts: { enabled: ["zzz"] } });
    assert.ok(warnings.some((w) => w.includes("zzz")));
  });
});

describe("TradeConfigError", () => {
  it("is an Error subclass", () => {
    const err = new TradeConfigError("bad");
    assert.equal(err.name, "TradeConfigError");
    assert.ok(err instanceof Error);
  });
});
