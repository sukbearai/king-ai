import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confluenceEnabled, enabledAlertRules, SLIM_ALERT_RULES } from "../src/trade/config.js";

describe("enabledAlertRules", () => {
  it("defaults to slim stack when alerts.enabled missing", () => {
    assert.deepEqual(enabledAlertRules({}), [...SLIM_ALERT_RULES]);
  });

  it("respects explicit alerts.enabled", () => {
    assert.deepEqual(enabledAlertRules({ alerts: { enabled: ["q"] } }), ["q"]);
  });
});

describe("fusion toggles", () => {
  it("confluence enabled by default", () => {
    assert.equal(confluenceEnabled({}), true);
    assert.equal(confluenceEnabled({ alerts: { confluence_enabled: false } }), false);
  });
});