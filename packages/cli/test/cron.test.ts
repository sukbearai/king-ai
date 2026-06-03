import assert from "node:assert/strict";
import { test } from "node:test";
import { cronMatches, matchesCron, parseCron } from "../src/cron.js";

test("parseCron supports exact daily schedules", () => {
  const schedule = parseCron("0 8 * * *");
  assert.equal(schedule.minutes.has(0), true);
  assert.equal(schedule.minutes.size, 1);
  assert.equal(schedule.hours.has(8), true);
  assert.equal(schedule.hours.size, 1);
  assert.equal(schedule.daysOfMonth.size, 31);
  assert.equal(schedule.months.size, 12);
  assert.equal(schedule.daysOfWeek.size, 7);
});

test("parseCron supports ranges, lists, and steps", () => {
  assert.deepEqual([...parseCron("*/15 * * * *").minutes], [0, 15, 30, 45]);
  assert.deepEqual([...parseCron("0 9 * * 1-5").daysOfWeek], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 9 * * 1,3,5").daysOfWeek], [1, 3, 5]);
  assert.deepEqual([...parseCron("0-30/10 * * * *").minutes], [0, 10, 20, 30]);
});

test("matchesCron checks date fields", () => {
  assert.equal(matchesCron(parseCron("0 8 * * *"), new Date(2026, 1, 26, 8, 0)), true);
  assert.equal(matchesCron(parseCron("0 8 * * *"), new Date(2026, 1, 26, 8, 1)), false);
  assert.equal(matchesCron(parseCron("0 9 * * 1"), new Date(2026, 1, 23, 9, 0)), true);
  assert.equal(matchesCron(parseCron("0 9 * * 1"), new Date(2026, 1, 24, 9, 0)), false);
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 0, 30)), true);
});

test("parseCron rejects malformed expressions", () => {
  assert.throws(() => parseCron("0 8 *"), /expected 5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /Invalid value/);
  assert.throws(() => parseCron("*/0 * * * *"), /Invalid step/);
  assert.throws(() => parseCron("5-1 * * * *"), /Invalid range/);
});
