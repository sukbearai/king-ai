import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG_DIR } from "../src/paths.js";
import {
  evaluateDiskHealth,
  resolveDiskWatchdogConfig,
  type DiskWatchdogConfig,
} from "../src/trade/process-watchdog.js";

const thresholds: DiskWatchdogConfig = {
  path: "/data",
  warningFreePercent: 15,
  criticalFreePercent: 8,
  recoveryFreePercent: 20,
};

describe("disk watchdog config", () => {
  it("uses defaults and accepts a valid custom config", () => {
    assert.deepEqual(resolveDiskWatchdogConfig({}), {
      path: CONFIG_DIR,
      warningFreePercent: 15,
      criticalFreePercent: 8,
      recoveryFreePercent: 20,
    });
    assert.deepEqual(
      resolveDiskWatchdogConfig({
        watchdog: {
          disk: {
            path: "/Volumes/archive",
            warning_free_percent: 12,
            critical_free_percent: 5,
            recovery_free_percent: 18,
          },
        },
      }),
      {
        path: "/Volumes/archive",
        warningFreePercent: 12,
        criticalFreePercent: 5,
        recoveryFreePercent: 18,
      },
    );
  });

  it("falls back to the complete default threshold set for invalid values or ordering", () => {
    const invalidRange = resolveDiskWatchdogConfig({
      watchdog: {
        disk: { warning_free_percent: 101, critical_free_percent: 5, recovery_free_percent: 20 },
      },
    });
    const invalidOrder = resolveDiskWatchdogConfig({
      watchdog: {
        disk: { warning_free_percent: 6, critical_free_percent: 8, recovery_free_percent: 20 },
      },
    });
    for (const config of [invalidRange, invalidOrder]) {
      assert.deepEqual(
        {
          warningFreePercent: config.warningFreePercent,
          criticalFreePercent: config.criticalFreePercent,
          recoveryFreePercent: config.recoveryFreePercent,
        },
        { warningFreePercent: 15, criticalFreePercent: 8, recoveryFreePercent: 20 },
      );
    }
  });
});

describe("disk watchdog transitions", () => {
  it("alerts when clear space enters warning or critical", () => {
    assert.deepEqual(evaluateDiskHealth("clear", 15, thresholds), { state: "warning", event: "warning" });
    assert.deepEqual(evaluateDiskHealth("clear", 8, thresholds), { state: "critical", event: "critical" });
  });

  it("escalates warning to critical without duplicating unchanged alerts", () => {
    assert.deepEqual(evaluateDiskHealth("warning", 7, thresholds), { state: "critical", event: "critical" });
    assert.deepEqual(evaluateDiskHealth("warning", 12, thresholds), { state: "warning", event: null });
    assert.deepEqual(evaluateDiskHealth("critical", 7, thresholds), { state: "critical", event: null });
  });

  it("recovers only at the recovery threshold and silently downgrades critical below it", () => {
    assert.deepEqual(evaluateDiskHealth("warning", 19.9, thresholds), { state: "warning", event: null });
    assert.deepEqual(evaluateDiskHealth("critical", 12, thresholds), { state: "warning", event: null });
    assert.deepEqual(evaluateDiskHealth("critical", 19, thresholds), { state: "warning", event: null });
    assert.deepEqual(evaluateDiskHealth("warning", 20, thresholds), { state: "clear", event: "recovered" });
  });
});
