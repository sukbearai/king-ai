import assert from "node:assert/strict";
import test from "node:test";
import { runCalendarCommand } from "../src/gui-cli-calendar.js";

const deps = {
  defaultAgentId: "king-ai-ceo",
  readOption: (args: string[], flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  },
  parseCron: () => ({})
};

test("calendar delete removes a due item", () => {
  const state = {
    calendar: [
      {
        id: "cal-test-1",
        title: "Follow up",
        at: "2000-01-01T00:00:00.000Z",
        assignee: "king-ai-ceo",
        created_at: 1
      }
    ]
  };
  assert.match(runCalendarCommand(state, ["delete", "cal-test-1"], deps), /calendar deleted cal-test-1/);
  assert.equal(state.calendar.length, 0);
});

test("calendar delete reports missing ids", () => {
  const state = { calendar: [] as { id: string; title: string; at: string; created_at: number }[] };
  assert.match(runCalendarCommand(state, ["delete", "cal-missing"], deps), /calendar not found/);
});