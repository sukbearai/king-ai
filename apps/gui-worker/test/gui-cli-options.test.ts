import assert from "node:assert/strict";
import { test } from "node:test";
import type { State } from "../src/gui-types.js";
import { parseAllowedPaths, pathConflict, readOption, stripOptions } from "../src/gui-cli-options.js";

test("readOption and stripOptions parse runtime CLI flags", () => {
  const args = ["create", "Ship", "--paths", "src/,lib", "--assign", "dev"];
  assert.equal(readOption(args, "--assign"), "dev");
  assert.deepEqual(stripOptions(args, ["--paths", "--assign"]), ["create", "Ship"]);
  assert.deepEqual(parseAllowedPaths(args), ["src", "lib"]);
});

test("pathConflict reports overlapping kanban claims", () => {
  const state = {
    cards: [{ id: "card-1", title: "A", column: "doing" as const, claimedBy: "dev", allowedPaths: ["src"], created_at: 0 }],
    claims: [],
    tasks: [],
    capsules: []
  } as unknown as State;
  assert.match(pathConflict(state, ["src/app"], "reviewer") ?? "", /card-1 claimed by dev/);
  assert.equal(pathConflict(state, ["docs"], "reviewer"), null);
});
