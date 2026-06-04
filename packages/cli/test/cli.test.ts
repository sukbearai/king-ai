import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commandNameFromArgv,
  computerHelpText,
  defaultServerForCommand,
  formatMaterializedTeamScenario,
  hasExplicitServerArg,
  materializeTeamScenario,
  normalizeComputerArgs,
  shouldRunAfterPair,
  versionText
} from "../src/cli.js";
import { listHostWorkflowCards } from "../src/host-ledger.js";
import { scenarioTemplate } from "../src/team-workflow.js";

test("computerHelpText matches King command sections", () => {
  const text = computerHelpText("https://runtime.example");
  assert.match(text, /king agent computer - run local BYOA agents/);
  assert.match(text, /Setup:/);
  assert.match(text, /Background service:/);
  assert.match(text, /Diagnostics:/);
  assert.match(text, /--pair <code>/);
  assert.match(text, /--install-service/);
  assert.match(text, /--watch/);
  assert.match(text, /--prepare-worktrees/);
  assert.match(text, /--cleanup-worktrees/);
  assert.match(text, /--doctor/);
  assert.match(text, /https:\/\/runtime\.example/);
});

test("computerHelpText can render king command names", () => {
  const text = computerHelpText("https://runtime.example", "king");
  assert.match(text, /king agent computer - run local BYOA agents/);
  assert.match(text, /king agent computer --pair <code>/);
});

test("normalizeComputerArgs accepts King bare help and doctor", () => {
  assert.deepEqual(normalizeComputerArgs(["computer", "help"]), ["computer", "--help"]);
  assert.deepEqual(normalizeComputerArgs(["computer", "doctor"]), ["computer", "--doctor"]);
  assert.deepEqual(normalizeComputerArgs(["computer", "--doctor"]), ["computer", "--doctor"]);
  assert.deepEqual(normalizeComputerArgs(["computer", "--pair", "help"]), ["computer", "--pair", "help"]);
});

test("commandNameFromArgv resolves the king command", () => {
  assert.equal(commandNameFromArgv("/usr/local/bin/king"), "king");
});

test("defaultServerForCommand preserves the production default", () => {
  assert.equal(defaultServerForCommand("king"), "https://api.king.ai");
});

test("hasExplicitServerArg detects only user supplied server flags", () => {
  assert.equal(hasExplicitServerArg(["agent", "computer"]), false);
  assert.equal(hasExplicitServerArg(["agent", "computer", "--server", "https://runtime.example"]), true);
  assert.equal(hasExplicitServerArg(["agent", "computer", "--server=https://runtime.example"]), true);
  assert.equal(hasExplicitServerArg(["agent", "computer", "--pair", "server"]), false);
});

test("versionText includes the command name", () => {
  assert.equal(versionText("king", "1.2.3"), "king 1.2.3");
});

test("pair continues into foreground daemon when no service is installed", () => {
  assert.equal(shouldRunAfterPair(false), true);
  assert.equal(shouldRunAfterPair(true), false);
});

test("package exposes king as the top-level bin", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", `file://${process.cwd()}/`), "utf8")) as {
    bin?: Record<string, string>;
    exports?: Record<string, { types?: string; default?: string }>;
  };
  assert.equal(pkg.bin?.king, "dist/src/cli.js");
  assert.equal(pkg.exports?.["./host-sdk"]?.types, "./dist/src/host-sdk.d.ts");
  assert.equal(pkg.exports?.["./host-sdk"]?.default, "./dist/src/host-sdk.js");
  assert.equal(pkg.exports?.["./team-workflow"]?.default, "./dist/src/team-workflow.js");
  assert.equal(pkg.exports?.["./team-routing"]?.default, "./dist/src/team-routing.js");
});

test("package host SDK export is importable", async () => {
  const sdk = await import("@suwujs/king/host-sdk");
  assert.equal(typeof sdk.createHostSdk, "function");
  assert.equal(typeof sdk.createBrowserHostSdk, "function");
  assert.equal(typeof sdk.createKingHostSdk, "function");
  assert.equal(typeof sdk.createEnvBackedKingHostSdk, "function");
  assert.equal(typeof sdk.createDefaultRunOptions, "function");
  assert.equal(typeof sdk.createRunOptions, "function");
  assert.equal(typeof sdk.createTakeoverRunOptions, "function");
});

test("package team collaboration exports are importable", async () => {
  const workflow = await import("@suwujs/king/team-workflow");
  const routing = await import("@suwujs/king/team-routing");
  assert.equal(typeof workflow.defaultTeamSpec, "function");
  assert.equal(typeof workflow.roleTemplateForAgent, "function");
  assert.equal(typeof workflow.requiredCapabilitiesForText, "function");
  assert.equal(typeof routing.selectOwnerRole, "function");
});

test("top-level help examples include local project profiling", async () => {
  const cli = await readFile(new URL("src/cli.ts", `file://${process.cwd()}/`), "utf8");
  assert.match(cli, /project-profile/);
  assert.match(cli, /usage/);
  assert.match(cli, /team repo-takeover --json/);
  assert.match(cli, /Materialize the scenario into this host output directory/);
  assert.match(cli, /host status --json/);
  assert.match(cli, /host run status --json/);
  assert.match(cli, /host plan-run "review this repo" --project \. --json/);
  assert.match(cli, /host preflight "review this repo" --project \./);
  assert.match(cli, /host submit-run "review this repo" --project \. --json/);
  assert.match(cli, /host run-requests --json/);
  assert.match(cli, /host emit-run-event demo app\.note --message "reviewed"/);
  assert.match(cli, /host run-results demo --json/);
  assert.match(cli, /host run-heartbeat demo --json/);
  assert.match(cli, /host run-meta demo --json/);
  assert.match(cli, /host execute-run/);
  assert.match(cli, /host plan-export --workspace \.\/agent-workspace --repo \. --json/);
  assert.match(cli, /host timeline --json/);
  assert.match(cli, /host policy export --json/);
  assert.match(cli, /host serve --port 8799/);
  assert.match(cli, /host serve --execute-runs/);
  assert.match(cli, /Inspect a local repository/);
  assert.match(cli, /Summarize local agent run usage/);
  assert.match(cli, /Preview or materialize built-in multi-role team workflow scenarios/);
  assert.match(cli, /Host application integration commands/);
  assert.match(cli, /List controlled host commands/);
  assert.match(cli, /Run an allowlisted local host command/);
  assert.match(cli, /Preview a reproducible host app run request/);
  assert.match(cli, /Check whether a host app run request is ready to launch/);
  assert.match(cli, /Persist a pending host app run request/);
  assert.match(cli, /List pending host app run requests/);
  assert.match(cli, /Show one host app run request/);
  assert.match(cli, /Append a lifecycle status update for a host app run request/);
  assert.match(cli, /Consume one pending host app run request with a safe local executor/);
  assert.match(cli, /Append an app-facing event to a host run output/);
  assert.match(cli, /Preview host artifact and repo patch export outputs/);
  assert.match(cli, /Export host artifacts and repo patches to an output directory/);
  assert.match(cli, /Show recent host command audit events/);
  assert.match(cli, /Check host command safety policy/);
  assert.match(cli, /Run a read-only localhost HTTP server/);
  assert.match(cli, /Automatically consume pending safe host run requests/);
});

test("materializeTeamScenario writes built-in scenario cards to the workflow ledger", async () => {
  const outputDir = join(await mkdtemp(join(tmpdir(), "king-team-scenario-")), "out");
  const result = await materializeTeamScenario(scenarioTemplate("bug-investigation"), outputDir, "planner");
  assert.equal(result.cards.length, 4);
  assert.match(formatMaterializedTeamScenario(result), /workflow cards: 4/);

  const cards = await listHostWorkflowCards({ outputDir });
  assert.equal(cards.length, 4);
  assert.equal(cards[0]?.kind, "initiative");
  assert.equal(cards.filter((card) => card.kind === "task").length, 3);
  assert.equal(cards.find((card) => card.id === "task-2")?.dependsOn[0], "task-1");
});
