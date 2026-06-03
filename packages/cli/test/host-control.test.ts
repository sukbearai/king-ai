import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listHostCommands, normalizeHostCommandName, runHostCommand } from "../src/host-control.js";

test("host commands expose only low-risk allowlisted actions", () => {
  const commands = listHostCommands();
  assert.deepEqual(commands.map((entry) => entry.name), ["status", "usage", "events", "timeline", "policy", "doctor", "plan-run", "preflight", "prepare-run-layout", "submit-run", "run-requests", "run-request", "update-run", "cancel-run", "execute-run", "emit-run-event", "watch-run", "run-results", "run-heartbeat", "run-meta", "plan-export", "export"]);
  assert.equal(commands.filter((entry) => entry.destructive).map((entry) => entry.name).join(","), "prepare-run-layout,export");
  assert.equal(normalizeHostCommandName("STATUS"), "status");
  assert.equal(normalizeHostCommandName("restart"), null);
  assert.equal(normalizeHostCommandName("stop"), null);
});

test("runHostCommand emits app events into host run loop event files", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-command-emit-event-"));
  const runsPath = join(root, "host-runs.ndjson");
  const outputDir = join(root, "out");

  await runHostCommand({
    command: "submit-run",
    input: {
      goal: "review event stream",
      requestId: "emit-request-1",
      options: { engine: "codex", outputDir }
    }
  }, {
    runsPath,
    availableEngines: () => ["codex"]
  });

  const emitted = await runHostCommand({
    command: "emit-run-event",
    input: {
      id: "emit-request-1",
      type: "app.note",
      message: "human reviewed",
      payload: { tab: "summary" }
    }
  }, {
    runsPath,
    now: () => new Date("2026-06-02T00:00:06.000Z")
  });

  assert.equal(emitted.ok, true);
  assert.match(emitted.text, /app\.note/);
  const json = emitted.json as { event?: { runId?: string; type?: string; timestamp?: string; source?: string; message?: string; payload?: { tab?: string } } };
  assert.equal(json.event?.runId, "emit-request-1");
  assert.equal(json.event?.type, "app.note");
  assert.equal(json.event?.timestamp, "2026-06-02T00:00:06.000Z");
  assert.equal(json.event?.source, "host-app");
  assert.equal(json.event?.message, "human reviewed");
  assert.equal(json.event?.payload?.tab, "summary");

  const watched = await runHostCommand({
    command: "watch-run",
    input: { id: "emit-request-1", type: "app.note", writeResults: false }
  }, {
    runsPath
  });
  assert.equal((watched.json as { filteredEvents?: number; events?: Array<{ message?: string }> }).filteredEvents, 1);
  assert.equal((watched.json as { events?: Array<{ message?: string }> }).events?.[0]?.message, "human reviewed");
});

test("runHostCommand records and reads host command timeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-command-timeline-"));
  const timelinePath = join(root, "host-events.ndjson");
  const readState = async () => ({
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    computerId: "demo-computer",
    agents: [],
    events: []
  });

  await runHostCommand({ command: "status" }, {
    readState,
    tokenBudget: () => null,
    recordTimeline: true,
    timelinePath,
    now: () => new Date("2026-06-02T00:00:03.000Z")
  });

  const timeline = await runHostCommand({
    command: "timeline",
    input: { limit: 5 }
  }, {
    timelinePath
  });
  assert.equal(timeline.ok, true);
  assert.match(timeline.text, /status ok exit=0/);
  assert.equal((timeline.json as { events?: Array<{ command?: string }> }).events?.[0]?.command, "status");
});

test("runHostCommand plans and writes host exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-command-export-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "result.txt"), "done", "utf8");

  const plan = await runHostCommand({
    command: "plan-export",
    input: { workspaceRoot: workspace, outputDir: join(root, "out"), runId: "run-1" }
  });
  assert.equal(plan.ok, true);
  assert.equal((plan.json as { workspaceFileCount?: number }).workspaceFileCount, 1);

  const blocked = await runHostCommand({
    command: "export",
    input: { workspaceRoot: workspace, outputDir: join(root, "out"), runId: "run-1" }
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 75);
  assert.match(blocked.text, /confirmation required/);

  const exported = await runHostCommand({
    command: "export",
    input: { workspaceRoot: workspace, outputDir: join(root, "out"), runId: "run-1", confirmed: true }
  });
  assert.equal(exported.ok, true);
  const writtenFiles = (exported.json as { writtenFiles?: string[] }).writtenFiles ?? [];
  assert.equal(writtenFiles.some((file) => file.endsWith("workspace")), true);
  assert.equal(writtenFiles.some((file) => file.endsWith("meta.json")), true);
});

test("runHostCommand returns status, usage, events, and doctor results", async () => {
  const readState = async () => ({
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    computerId: "demo-computer",
    agents: [{
      id: "demo-agent",
      name: "Demo Agent",
      engine: "codex",
      runStats: {
        turns: 1,
        completed: 1,
        failed: 0,
        inputTokens: 10,
        cacheReadInputTokens: 0,
        outputTokens: 5,
        totalTokens: 15
      },
      updatedAt: "2026-06-02T00:00:01.000Z"
    }],
    events: [{ at: "2026-06-02T00:00:02.000Z", kind: "agent.started", detail: "demo-agent" }]
  });

  const usagePricing = () => [{
    key: "codex:*",
    currency: "USD",
    inputPerMillionTokens: 2,
    outputPerMillionTokens: 10
  }];
  const status = await runHostCommand({ command: "status" }, { readState, tokenBudget: () => 100, usagePricing });
  assert.equal(status.ok, true);
  assert.equal(status.exitCode, 0);
  assert.match(status.text, /demo-computer/);
  assert.equal((status.json as { usage?: { cost?: { amount?: number } } }).usage?.cost?.amount, 0.00007);

  const usage = await runHostCommand({ command: "usage" }, { readState, tokenBudget: () => 100, usagePricing });
  assert.equal(usage.ok, true);
  assert.match(usage.text, /tokens=15/);
  assert.match(usage.text, /estimated cost: USD 0\.000070/);
  assert.deepEqual((usage.json as { totalTokens?: number }).totalTokens, 15);
  assert.equal((usage.json as { cost?: { amount?: number } }).cost?.amount, 0.00007);

  const events = await runHostCommand({ command: "events" }, { readState, tokenBudget: () => null });
  assert.equal(events.ok, true);
  assert.match(events.text, /agent.started demo-agent/);

  const policy = await runHostCommand({ command: "policy", input: { command: "export" } });
  assert.equal(policy.ok, false);
  assert.equal(policy.exitCode, 1);
  assert.match(policy.text, /confirmation required/);

  const doctor = await runHostCommand({ command: "doctor" }, {
    collectDoctorResults: async () => [{
      id: "codex",
      installed: true,
      path: "codex",
      big: { ok: true },
      small: { ok: true }
    }]
  });
  assert.equal(doctor.ok, true);
  assert.match(doctor.text, /codex/);

  const plan = await runHostCommand({
    command: "plan-run",
    input: {
      goal: "inspect the repo",
      options: { engine: "claude" }
    }
  }, {
    availableEngines: () => ["claude"]
  });
  assert.equal(plan.ok, true);
  assert.match(plan.text, /goal: inspect the repo/);
  assert.equal((plan.json as { spec?: { goal?: string } }).spec?.goal, "inspect the repo");

  const preflight = await runHostCommand({
    command: "preflight",
    input: {
      goal: "inspect the repo",
      options: { engine: "claude" }
    }
  }, {
    availableEngines: () => ["claude"]
  });
  assert.equal(preflight.ok, true);
  assert.match(preflight.text, /ready: yes/);
});

test("runHostCommand materializes host run layouts only after confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-command-layout-"));
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".git"), { recursive: true });
  await mkdir(join(projectDir, "agents", "dev"), { recursive: true });
  await writeFile(join(projectDir, "agents", "dev", "AGENT.md"), "# Dev\n", "utf8");
  await writeFile(join(projectDir, "agents.json"), JSON.stringify({
    agents: [{ id: "dev", name: "Dev", engine: "codex" }],
    apiKey: "secret-key"
  }), "utf8");

  const blocked = await runHostCommand({
    command: "prepare-run-layout",
    input: {
      goal: "prepare layout",
      runId: "layout-1",
      projectDir,
      options: { outputDir: join(root, "out"), engine: "codex" }
    }
  }, {
    availableEngines: () => ["codex"]
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 75);
  assert.match(blocked.text, /confirmation required/);

  const prepared = await runHostCommand({
    command: "prepare-run-layout",
    input: {
      goal: "prepare layout",
      runId: "layout-1",
      projectDir,
      options: { outputDir: join(root, "out"), engine: "codex" },
      confirmation: "allow:prepare-run-layout"
    }
  }, {
    availableEngines: () => ["codex"]
  });
  assert.equal(prepared.ok, true);
  const json = prepared.json as { launchPlan?: { layout?: { configPath?: string; workspaceRoot?: string; exists?: boolean } }; writtenFiles?: string[] };
  assert.equal(json.launchPlan?.layout?.exists, true);
  assert.equal(json.writtenFiles?.some((file) => file.endsWith("agents.json")), true);
  assert.equal(json.writtenFiles?.some((file) => file.endsWith("loop-events.ndjson")), true);
  assert.equal(json.writtenFiles?.some((file) => file.endsWith("results.tsv")), true);
  assert.equal(json.writtenFiles?.some((file) => file.endsWith(".king/heartbeat.json")), true);
  assert.equal(json.writtenFiles?.some((file) => file.endsWith("meta.json")), true);
  const preparedConfig = await readFile(json.launchPlan!.layout!.configPath!, "utf8");
  assert.match(preparedConfig, /"workspaceRoot"/);
  assert.equal(preparedConfig.includes("secret-key"), false);
  assert.match(await readFile(json.launchPlan!.layout!.workspaceRoot! + "/dev/AGENT.md", "utf8"), /# Dev/);
  assert.equal((await readFile(json.launchPlan!.layout!.workspaceRoot! + "/dev/AGENT.md", "utf8")).trim(), "# Dev");
  assert.equal(await readFile(join(root, "out", "loop-events.ndjson"), "utf8"), "");
  const results = await readFile(join(root, "out", "results.tsv"), "utf8");
  assert.match(results, /^run_id\tloop\ttimestamp\tclassification\ttasks_created\ttasks_done\tartifacts_created\tpending_messages\tcompletion_rate\tnotes\n$/);
  const heartbeat = JSON.parse(await readFile(join(root, "out", ".king", "heartbeat.json"), "utf8")) as { schema?: string; status?: string; runId?: string; loopCount?: number; outputDir?: string };
  assert.equal(heartbeat.schema, "king.host-run-heartbeat.v1");
  assert.equal(heartbeat.status, "prepared");
  assert.equal(heartbeat.runId, "layout-1");
  assert.equal(heartbeat.loopCount, 0);
  assert.equal(heartbeat.outputDir, join(root, "out"));
  const meta = JSON.parse(await readFile(join(root, "out", "meta.json"), "utf8")) as { schema?: string; status?: string; runId?: string; actualLoops?: number; paths?: { workspaceRoot?: string; resultsPath?: string; heartbeatPath?: string } };
  assert.equal(meta.schema, "king.host-run-meta.v1");
  assert.equal(meta.status, "prepared");
  assert.equal(meta.runId, "layout-1");
  assert.equal(meta.actualLoops, 0);
  assert.equal(meta.paths?.workspaceRoot, json.launchPlan!.layout!.workspaceRoot);
  assert.equal(meta.paths?.resultsPath, join(root, "out", "results.tsv"));
  assert.equal(meta.paths?.heartbeatPath, join(root, "out", ".king", "heartbeat.json"));
  assert.match(prepared.text, /written files:/);

  await writeFile(join(root, "out", "loop-events.ndjson"), [
    JSON.stringify({ type: "loop.classified", runId: "layout-1", loop: 1, classification: "productive", timestamp: "2026-06-02T00:00:00.000Z" }),
    JSON.stringify({ type: "queue.backlog", runId: "layout-1", loop: 1, agent: "feedback", pendingMessages: 2, timestamp: "2026-06-02T00:00:01.000Z" })
  ].join("\n") + "\n", "utf8");
  const watched = await runHostCommand({
    command: "watch-run",
    input: {
      outputDir: join(root, "out"),
      type: "loop.classified"
    }
  });
  assert.equal(watched.ok, true);
  assert.match(watched.text, /productive/);
  assert.match(watched.text, /results: .*results\.tsv \(1 rows\)/);
  assert.equal((watched.json as { filteredEvents?: number; summary?: { productiveRate?: number } }).filteredEvents, 1);
  assert.equal((watched.json as { summary?: { productiveRate?: number } }).summary?.productiveRate, 100);
  assert.match(await readFile(join(root, "out", "results.tsv"), "utf8"), /layout-1\t1\t2026-06-02T00:00:00\.000Z\tproductive/);
  const runResults = await runHostCommand({
    command: "run-results",
    input: {
      outputDir: join(root, "out")
    }
  });
  assert.equal(runResults.ok, true);
  assert.equal((runResults.json as { rows?: unknown[] }).rows?.length, 1);
  assert.match(runResults.text, /^run_id\tloop\ttimestamp\tclassification/);
  const heartbeatRead = await runHostCommand({
    command: "run-heartbeat",
    input: {
      outputDir: join(root, "out")
    }
  });
  assert.equal(heartbeatRead.ok, true);
  assert.match(heartbeatRead.text, /status: prepared/);
  assert.equal((heartbeatRead.json as { heartbeat?: { status?: string; runId?: string } }).heartbeat?.status, "prepared");
  assert.equal((heartbeatRead.json as { heartbeat?: { status?: string; runId?: string } }).heartbeat?.runId, "layout-1");
  const metaRead = await runHostCommand({
    command: "run-meta",
    input: {
      outputDir: join(root, "out")
    }
  });
  assert.equal(metaRead.ok, true);
  assert.match(metaRead.text, /status: prepared/);
  assert.equal((metaRead.json as { meta?: { status?: string; runId?: string; paths?: { heartbeatPath?: string } } }).meta?.status, "prepared");
  assert.equal((metaRead.json as { meta?: { status?: string; runId?: string; paths?: { heartbeatPath?: string } } }).meta?.runId, "layout-1");
  assert.equal((metaRead.json as { meta?: { status?: string; runId?: string; paths?: { heartbeatPath?: string } } }).meta?.paths?.heartbeatPath, join(root, "out", ".king", "heartbeat.json"));

  const duplicate = await runHostCommand({
    command: "prepare-run-layout",
    input: {
      goal: "prepare layout",
      runId: "layout-1",
      projectDir,
      options: { outputDir: join(root, "out"), engine: "codex" },
      confirmation: "allow:prepare-run-layout"
    }
  }, {
    availableEngines: () => ["codex"]
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error ?? duplicate.text, /already exists/);
});

test("prepare-run-layout creates King default agents and missing guides", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-command-default-layout-"));
  const prepared = await runHostCommand({
    command: "prepare-run-layout",
    input: {
      goal: "prepare default layout",
      runId: "default-layout",
      options: { outputDir: join(root, "out"), engine: "claude" },
      confirmation: "allow:prepare-run-layout"
    }
  }, {
    availableEngines: () => ["claude"]
  });
  assert.equal(prepared.ok, true);
  const json = prepared.json as { launchPlan?: { layout?: { configPath?: string; workspaceRoot?: string } }; writtenFiles?: string[] };
  const config = JSON.parse(await readFile(json.launchPlan!.layout!.configPath!, "utf8")) as { agents?: Array<{ id?: string; lifecycle?: string; tier?: string; engine?: string }> };
  assert.deepEqual(config.agents?.map((agent) => agent.id), ["ceo", "dev", "feedback"]);
  assert.equal(config.agents?.[0]?.lifecycle, "24/7");
  assert.equal(config.agents?.[0]?.tier, "high");
  assert.equal(config.agents?.[1]?.tier, "standard");
  assert.equal(config.agents?.every((agent) => agent.engine === "claude"), true);
  assert.match(await readFile(join(json.launchPlan!.layout!.workspaceRoot!, "ceo", "AGENT.md"), "utf8"), /Turn the run goal/);
  assert.match(await readFile(join(json.launchPlan!.layout!.workspaceRoot!, "feedback", "AGENT.md"), "utf8"), /Review outputs/);
  assert.equal(json.writtenFiles?.some((file) => file.endsWith("ceo/AGENT.md")), true);
});

test("runHostCommand persists and lists pending host run requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-command-runs-"));
  const runsPath = join(root, "host-runs.ndjson");
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".git"), { recursive: true });

  const submitted = await runHostCommand({
    command: "submit-run",
    input: {
      goal: "review this repo",
      requestId: "app-request-1",
      projectDir,
      options: { engine: "codex", outputDir: join(root, "request-out") }
    }
  }, {
    runsPath,
    availableEngines: () => ["codex"],
    now: () => new Date("2026-06-02T00:00:04.000Z")
  });
  assert.equal(submitted.ok, true);
  assert.match(submitted.text, /app-request-1 pending/);
  assert.equal((submitted.json as { request?: { id?: string; ready?: boolean } }).request?.id, "app-request-1");
  assert.equal((submitted.json as { request?: { id?: string; ready?: boolean } }).request?.ready, true);

  const listed = await runHostCommand({
    command: "run-requests",
    input: { limit: 5 }
  }, {
    runsPath
  });
  assert.equal(listed.ok, true);
  assert.match(listed.text, /review this repo/);
  assert.equal((listed.json as { requests?: Array<{ id?: string }> }).requests?.[0]?.id, "app-request-1");

  const single = await runHostCommand({
    command: "run-request",
    input: { id: "app-request-1" }
  }, {
    runsPath
  });
  assert.equal(single.ok, true);
  assert.equal((single.json as { request?: { id?: string; status?: string } }).request?.status, "pending");

  const running = await runHostCommand({
    command: "update-run",
    input: { id: "app-request-1", status: "running", detail: "executor picked it up" }
  }, {
    runsPath,
    now: () => new Date("2026-06-02T00:00:05.000Z")
  });
  assert.equal(running.ok, true);
  assert.match(running.text, /running/);
  assert.match(running.text, /executor picked it up/);
  const runningHeartbeat = JSON.parse(await readFile(join(root, "request-out", ".king", "heartbeat.json"), "utf8")) as { status?: string; runId?: string; detail?: string; loopCount?: number };
  assert.equal(runningHeartbeat.status, "running");
  assert.equal(runningHeartbeat.runId, "app-request-1");
  assert.equal(runningHeartbeat.detail, "executor picked it up");
  assert.equal(runningHeartbeat.loopCount, 0);
  const runningMeta = JSON.parse(await readFile(join(root, "request-out", "meta.json"), "utf8")) as { status?: string; runId?: string; detail?: string; actualLoops?: number; updatedAt?: string };
  assert.equal(runningMeta.status, "running");
  assert.equal(runningMeta.runId, "app-request-1");
  assert.equal(runningMeta.detail, "executor picked it up");
  assert.equal(runningMeta.actualLoops, 0);
  assert.equal(runningMeta.updatedAt, "2026-06-02T00:00:05.000Z");
  const runningEvents = parseNdjson(await readFile(join(root, "request-out", "loop-events.ndjson"), "utf8"));
  assert.equal(runningEvents.length, 1);
  assert.equal(runningEvents[0]?.type, "run.status");
  assert.equal(runningEvents[0]?.status, "running");
  assert.equal(runningEvents[0]?.source, "update-run");
  assert.equal(runningEvents[0]?.timestamp, "2026-06-02T00:00:05.000Z");

  const runningOnly = await runHostCommand({
    command: "run-requests",
    input: { status: "running" }
  }, {
    runsPath
  });
  assert.equal((runningOnly.json as { requests?: Array<{ id?: string; status?: string }> }).requests?.[0]?.status, "running");

  const cancelled = await runHostCommand({
    command: "cancel-run",
    input: { id: "app-request-1", detail: "cancelled by app" }
  }, {
    runsPath,
    now: () => new Date("2026-06-02T00:00:06.000Z")
  });
  assert.equal(cancelled.ok, true);
  assert.match(cancelled.text, /app-request-1 cancelled/);
  assert.match(cancelled.text, /cancelled by app/);
  const cancelledHeartbeat = JSON.parse(await readFile(join(root, "request-out", ".king", "heartbeat.json"), "utf8")) as { status?: string; detail?: string };
  assert.equal(cancelledHeartbeat.status, "cancelled");
  assert.equal(cancelledHeartbeat.detail, "cancelled by app");
  const cancelledEvents = parseNdjson(await readFile(join(root, "request-out", "loop-events.ndjson"), "utf8"));
  assert.equal(cancelledEvents.at(-1)?.status, "cancelled");
  assert.equal(cancelledEvents.at(-1)?.source, "update-run");

  const missing = await runHostCommand({
    command: "run-request",
    input: { id: "missing" }
  }, {
    runsPath
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.exitCode, 66);
});

test("runHostCommand executes safe pending host run requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-command-execute-"));
  const runsPath = join(root, "host-runs.ndjson");

  await runHostCommand({
    command: "submit-run",
    input: {
      goal: "check status",
      requestId: "exec-request-1",
      options: { outputDir: join(root, "exec-out") },
      executor: {
        kind: "host-command",
        command: "status",
        format: "json"
      }
    }
  }, {
    runsPath,
    availableEngines: () => ["codex"],
    now: () => new Date("2026-06-02T00:00:04.000Z")
  });

  const executed = await runHostCommand({
    command: "execute-run",
    input: { id: "exec-request-1" }
  }, {
    runsPath,
    readState: async () => ({
      version: "0.1.0",
      pid: 123,
      startedAt: "2026-06-02T00:00:00.000Z",
      computerId: "demo-computer",
      agents: [],
      events: []
    }),
    tokenBudget: () => null,
    now: () => new Date("2026-06-02T00:00:05.000Z")
  });
  assert.equal(executed.ok, true);
  assert.match(executed.text, /completed/);
  assert.equal((executed.json as { request?: { status?: string; result?: { command?: string } } }).request?.status, "completed");
  assert.equal((executed.json as { request?: { status?: string; result?: { command?: string } } }).request?.result?.command, "status");
  const completedHeartbeat = JSON.parse(await readFile(join(root, "exec-out", ".king", "heartbeat.json"), "utf8")) as { status?: string; runId?: string; command?: string; exitCode?: number; loopCount?: number };
  assert.equal(completedHeartbeat.status, "completed");
  assert.equal(completedHeartbeat.runId, "exec-request-1");
  assert.equal(completedHeartbeat.command, "status");
  assert.equal(completedHeartbeat.exitCode, 0);
  assert.equal(completedHeartbeat.loopCount, 1);
  const completedMeta = JSON.parse(await readFile(join(root, "exec-out", "meta.json"), "utf8")) as { status?: string; runId?: string; command?: string; exitCode?: number; actualLoops?: number; completedAt?: string };
  assert.equal(completedMeta.status, "completed");
  assert.equal(completedMeta.runId, "exec-request-1");
  assert.equal(completedMeta.command, "status");
  assert.equal(completedMeta.exitCode, 0);
  assert.equal(completedMeta.actualLoops, 1);
  assert.equal(completedMeta.completedAt, "2026-06-02T00:00:05.000Z");
  const completedEvents = parseNdjson(await readFile(join(root, "exec-out", "loop-events.ndjson"), "utf8"));
  assert.deepEqual(completedEvents.map((event) => event.status), ["running", "completed"]);
  assert.deepEqual(completedEvents.map((event) => event.source), ["execute-run", "execute-run"]);
  assert.deepEqual(completedEvents.map((event) => event.loop), [0, 1]);

  await runHostCommand({
    command: "submit-run",
    input: {
      goal: "try export",
      requestId: "exec-request-2",
      options: { outputDir: join(root, "blocked-out") },
      executor: {
        kind: "host-command",
        command: "export"
      }
    }
  }, {
    runsPath,
    availableEngines: () => ["codex"]
  });
  const blocked = await runHostCommand({
    command: "execute-run",
    input: { id: "exec-request-2" }
  }, {
    runsPath
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /not allowed/);
  assert.equal((blocked.json as { request?: { status?: string } }).request?.status, "failed");
  const failedHeartbeat = JSON.parse(await readFile(join(root, "blocked-out", ".king", "heartbeat.json"), "utf8")) as { status?: string; runId?: string; command?: string; exitCode?: number; loopCount?: number };
  assert.equal(failedHeartbeat.status, "failed");
  assert.equal(failedHeartbeat.runId, "exec-request-2");
  assert.equal(failedHeartbeat.command, "export");
  assert.equal(failedHeartbeat.exitCode, 64);
  assert.equal(failedHeartbeat.loopCount, 0);
  const failedMeta = JSON.parse(await readFile(join(root, "blocked-out", "meta.json"), "utf8")) as { status?: string; runId?: string; command?: string; exitCode?: number; actualLoops?: number };
  assert.equal(failedMeta.status, "failed");
  assert.equal(failedMeta.runId, "exec-request-2");
  assert.equal(failedMeta.command, "export");
  assert.equal(failedMeta.exitCode, 64);
  assert.equal(failedMeta.actualLoops, 0);
  const failedEvents = parseNdjson(await readFile(join(root, "blocked-out", "loop-events.ndjson"), "utf8"));
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0]?.status, "failed");
  assert.equal(failedEvents[0]?.source, "execute-run");
  assert.equal(failedEvents[0]?.exitCode, 64);
});

test("runHostCommand rejects unsupported actions", async () => {
  const result = await runHostCommand({ command: "restart" });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 64);
  assert.match(result.text, /unsupported host command/);
});

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}
