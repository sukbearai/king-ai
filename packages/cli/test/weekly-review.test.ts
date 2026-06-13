import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDriftReport, buildWeeklyReport } from "../src/trade/weekly-review.js";

test("buildDriftReport formats drift entries", () => {
  const report = buildDriftReport([{
    rule: "Meme 新币",
    recent_rate: 12,
    recent_n: 15,
    baseline_rate: 80,
    baseline_n: 40,
    delta_pp: -68
  }]);
  assert.match(report, /断崖预警/);
  assert.match(report, /Meme 新币/);
});

test("buildWeeklyReport includes overall line", () => {
  const report = buildWeeklyReport(
    [{ rule: "a", total: 10, validated: 8, hits: 6, hit_rate: 75, avg_pct: 1.2, avg_strength: 0.5 }],
    [{ rule: "a", total: 20, validated: 18, hits: 12, hit_rate: 66.7, avg_pct: 0.8, avg_strength: 0.4 }],
    []
  );
  assert.match(report, /信号质量周报/);
  assert.match(report, /Overall 7d/);
});