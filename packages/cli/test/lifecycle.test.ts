import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgentLifecycle, runtimeLifecycleNote, shouldHostAgent } from "../src/lifecycle.js";

test("normalizeAgentLifecycle defaults unknown values to on-demand", () => {
  assert.equal(normalizeAgentLifecycle("24/7"), "24/7");
  assert.equal(normalizeAgentLifecycle("idle_cached"), "idle_cached");
  assert.equal(normalizeAgentLifecycle("disabled"), "disabled");
  assert.equal(normalizeAgentLifecycle("bad"), "on-demand");
  assert.equal(normalizeAgentLifecycle(undefined), "on-demand");
});

test("shouldHostAgent only excludes disabled agents", () => {
  assert.equal(shouldHostAgent("on-demand"), true);
  assert.equal(shouldHostAgent("24/7"), true);
  assert.equal(shouldHostAgent("idle_cached"), true);
  assert.equal(shouldHostAgent("disabled"), false);
});

test("runtimeLifecycleNote explains local daemon lifecycle semantics", () => {
  assert.match(runtimeLifecycleNote("disabled"), /not hosted/);
  assert.match(runtimeLifecycleNote("24/7"), /event driven/);
  assert.match(runtimeLifecycleNote("on-demand"), /runtime activity/);
});
