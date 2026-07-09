import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listHostCommands, normalizeHostCommandName, runHostCommand } from "../src/host-control.js";

const EXPECTED_HOST_COMMANDS = [
  "status",
  "usage",
  "expenses",
  "events",
  "timeline",
  "policy",
  "doctor",
  "plan-run",
  "preflight",
  "prepare-run-layout",
  "submit-run",
  "run-requests",
  "run-request",
  "update-run",
  "cancel-run",
  "execute-run",
  "task-create",
  "task-list",
  "task-update",
  "agenda",
  "capsule-create",
  "capsule-list",
  "capsule-update",
  "workflow-create",
  "workflow-list",
  "workflow-update",
  "initiative-create",
  "handoff-create",
  "review-create",
  "decision-create",
  "artifact-create",
  "feedback-record",
  "feedback-list",
  "feedback-summary",
  "cron-check",
  "emit-run-event",
  "watch-run",
  "run-results",
  "run-heartbeat",
  "run-meta",
  "plan-export",
  "export",
  "compact-ledger",
  "remote-config-get",
  "remote-config-save",
  "remote-list",
  "remote-save-device",
  "remote-delete-device",
  "remote-default-device",
  "remote-probe",
  "remote-profile",
  "remote-run",
  "remote-logs",
  "remote-find-logs",
  "remote-pg",
  "remote-redis",
];

test("host commands expose only low-risk allowlisted actions", () => {
  const commands = listHostCommands();
  assert.deepEqual(
    commands.map((entry) => entry.name),
    EXPECTED_HOST_COMMANDS,
  );
  assert.equal(
    commands
      .filter((entry) => entry.destructive)
      .map((entry) => entry.name)
      .join(","),
    "prepare-run-layout,export,compact-ledger",
  );
  assert.equal(normalizeHostCommandName("STATUS"), "status");
  assert.equal(normalizeHostCommandName("restart"), null);
  assert.equal(normalizeHostCommandName("stop"), null);
});

test("runHostCommand maintains first-class workflow objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-workflow-"));
  const outputDir = join(root, "out");

  const initiative = await runHostCommand(
    {
      command: "initiative-create",
      input: {
        outputDir,
        id: "initiative-1",
        title: "Repo takeover",
        ownerRole: "planner",
        acceptance: ["tasks have owners"],
      },
    },
    {
      now: () => new Date("2026-06-02T00:00:00.000Z"),
    },
  );
  assert.equal((initiative.json as { card?: { kind?: string; ownerRole?: string } }).card?.kind, "initiative");
  assert.equal((initiative.json as { card?: { kind?: string; ownerRole?: string } }).card?.ownerRole, "planner");

  const decision = await runHostCommand(
    {
      command: "decision-create",
      input: {
        outputDir,
        id: "decision-1",
        title: "Ship release?",
        ownerRole: "ops",
        reviewerRole: "planner",
        decisionBy: "human",
        detail: "Need human approval before release",
      },
    },
    {
      now: () => new Date("2026-06-02T00:00:01.000Z"),
    },
  );
  assert.equal((decision.json as { card?: { status?: string; decisionBy?: string } }).card?.status, "waiting_human");
  assert.equal((decision.json as { card?: { status?: string; decisionBy?: string } }).card?.decisionBy, "human");

  await runHostCommand(
    {
      command: "handoff-create",
      input: {
        outputDir,
        id: "handoff-1",
        title: "Builder to reviewer",
        ownerRole: "builder",
        reviewerRole: "reviewer",
        targetRole: "reviewer",
        sourceId: "initiative-1",
        handoffPolicy: {
          mode: "review-required",
          reviewerRole: "reviewer",
          escalation: "human",
          acceptanceRequired: true,
        },
      },
    },
    {
      now: () => new Date("2026-06-02T00:00:02.000Z"),
    },
  );

  const reviewed = await runHostCommand(
    {
      command: "workflow-update",
      input: {
        outputDir,
        id: "handoff-1",
        status: "review",
        result: "ready for reviewer",
      },
    },
    {
      now: () => new Date("2026-06-02T00:00:03.000Z"),
    },
  );
  assert.equal((reviewed.json as { card?: { status?: string; result?: string } }).card?.status, "review");

  const listed = await runHostCommand({ command: "workflow-list", input: { outputDir, reviewerRole: "reviewer" } });
  assert.match(listed.text, /handoff-1 handoff review/);
  assert.equal(
    (listed.json as { cards?: Array<{ id?: string }> }).cards?.some((card) => card.id === "handoff-1"),
    true,
  );
});

test("runHostCommand maintains local task capsule agenda and feedback ledgers", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-ledger-"));
  const outputDir = join(root, "out");

  await runHostCommand(
    {
      command: "task-create",
      input: { outputDir, id: "task-1", title: "Design capsule", assignee: "ceo" },
    },
    {
      now: () => new Date("2026-06-02T00:00:00.000Z"),
    },
  );
  await runHostCommand(
    {
      command: "task-create",
      input: { outputDir, id: "task-2", title: "Implement capsule", assignee: "dev", dependsOn: ["task-1"] },
    },
    {
      now: () => new Date("2026-06-02T00:00:01.000Z"),
    },
  );

  const blockedAgenda = await runHostCommand({ command: "agenda", input: { outputDir } });
  assert.equal((blockedAgenda.json as { readyCount?: number; blockedCount?: number }).readyCount, 1);
  assert.equal((blockedAgenda.json as { readyCount?: number; blockedCount?: number }).blockedCount, 1);
  assert.match(blockedAgenda.text, /blocked task-2/);
  await assert.rejects(
    runHostCommand({ command: "task-update", input: { outputDir, id: "task-2", status: "done", result: "too early" } }),
    /depends on unfinished tasks: task-1/,
  );

  await runHostCommand(
    {
      command: "task-update",
      input: { outputDir, id: "task-1", status: "done", result: "accepted" },
    },
    {
      now: () => new Date("2026-06-02T00:00:02.000Z"),
    },
  );
  const readyAgenda = await runHostCommand({ command: "agenda", input: { outputDir } });
  assert.equal((readyAgenda.json as { readyCount?: number; blockedCount?: number }).readyCount, 1);
  assert.equal((readyAgenda.json as { readyCount?: number; blockedCount?: number }).blockedCount, 0);

  await runHostCommand({
    command: "task-create",
    input: { outputDir, id: "task-3", title: "Verify evidence", acceptance: ["command output recorded"] },
  });
  await assert.rejects(
    runHostCommand({ command: "task-update", input: { outputDir, id: "task-3", status: "done" } }),
    /requires result before marking done/,
  );

  const capsule = await runHostCommand(
    {
      command: "capsule-create",
      input: {
        outputDir,
        id: "capsule-1",
        taskId: "task-2",
        goal: "Implement scoped change",
        owner: "dev",
        branchOrWorktree: "agent/dev",
        allowedPaths: ["packages/cli/src/host-ledger.ts"],
        acceptance: ["agenda marks task ready"],
        reviewer: "cto",
        verificationCommands: ["pnpm --filter @suwujs/king-ai test"],
      },
    },
    {
      now: () => new Date("2026-06-02T00:00:03.000Z"),
    },
  );
  assert.equal((capsule.json as { capsule?: { id?: string } }).capsule?.id, "capsule-1");

  await runHostCommand(
    {
      command: "feedback-record",
      input: {
        outputDir,
        runId: "run-1",
        agent: "dev",
        taskId: "task-2",
        capsuleId: "capsule-1",
        skill: "typescript",
        status: "completed",
        inputTokens: 10,
        outputTokens: 5,
      },
    },
    {
      now: () => new Date("2026-06-02T00:00:04.000Z"),
    },
  );
  const feedback = await runHostCommand({ command: "feedback-summary", input: { outputDir } });
  assert.equal((feedback.json as { records?: number; completed?: number; totalTokens?: number }).records, 1);
  assert.equal((feedback.json as { records?: number; completed?: number; totalTokens?: number }).completed, 1);
  assert.equal((feedback.json as { records?: number; completed?: number; totalTokens?: number }).totalTokens, 15);
});

test("runHostCommand cron-check emits matching local run events", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-cron-"));
  const outputDir = join(root, "out");

  const result = await runHostCommand({
    command: "cron-check",
    input: {
      outputDir,
      runId: "run-1",
      now: "2026-06-02T00:15:00.000Z",
      schedules: [
        { id: "quarter-hour", cron: "15 * * * *", type: "agenda.tick", message: "check agenda" },
        { id: "wrong-minute", cron: "16 * * * *", type: "agenda.skip" },
      ],
    },
  });

  assert.equal((result.json as { matched?: number }).matched, 1);
  const watched = await runHostCommand({
    command: "watch-run",
    input: { outputDir, type: "agenda.tick", writeResults: false },
  });
  assert.equal(
    (watched.json as { filteredEvents?: number; events?: Array<{ source?: string; message?: string }> }).filteredEvents,
    1,
  );
  assert.equal(
    (watched.json as { events?: Array<{ source?: string; message?: string }> }).events?.[0]?.source,
    "cron-check",
  );
  assert.equal(
    (watched.json as { events?: Array<{ source?: string; message?: string }> }).events?.[0]?.message,
    "check agenda",
  );
});

test("runHostCommand emits app events into host run loop event files", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-command-emit-event-"));
  const runsPath = join(root, "host-runs.ndjson");
  const outputDir = join(root, "out");

  await runHostCommand(
    {
      command: "submit-run",
      input: {
        goal: "review event stream",
        requestId: "emit-request-1",
        options: { engine: "codex", outputDir },
      },
    },
    {
      runsPath,
      availableEngines: () => ["codex"],
      teamSpec: () => ({
        id: "queue-only",
        name: "Queue Only",
        roles: [],
        routingPolicy: { defaultMode: "one-of-us", capabilityFirst: true, reviewRequiredFor: [], humanDecisionFor: [] },
        permissionPolicy: { defaultDecision: "deny", rules: [{ role: "ops", allow: ["manage-queue"] }] },
      }),
    },
  );

  const emitted = await runHostCommand(
    {
      command: "emit-run-event",
      input: {
        id: "emit-request-1",
        type: "app.note",
        message: "human reviewed",
        payload: { tab: "summary" },
      },
    },
    {
      runsPath,
      now: () => new Date("2026-06-02T00:00:06.000Z"),
    },
  );

  assert.equal(emitted.ok, true);
  assert.match(emitted.text, /app\.note/);
  const json = emitted.json as {
    event?: {
      runId?: string;
      type?: string;
      timestamp?: string;
      source?: string;
      message?: string;
      payload?: { tab?: string };
    };
  };
  assert.equal(json.event?.runId, "emit-request-1");
  assert.equal(json.event?.type, "app.note");
  assert.equal(json.event?.timestamp, "2026-06-02T00:00:06.000Z");
  assert.equal(json.event?.source, "host-app");
  assert.equal(json.event?.message, "human reviewed");
  assert.equal(json.event?.payload?.tab, "summary");

  const watched = await runHostCommand(
    {
      command: "watch-run",
      input: { id: "emit-request-1", type: "app.note", writeResults: false },
    },
    {
      runsPath,
    },
  );
  assert.equal((watched.json as { filteredEvents?: number; events?: Array<{ message?: string }> }).filteredEvents, 1);
  assert.equal((watched.json as { events?: Array<{ message?: string }> }).events?.[0]?.message, "human reviewed");
});

test("runHostCommand records and reads host command timeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-command-timeline-"));
  const timelinePath = join(root, "host-events.ndjson");
  const readState = async () => ({
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    computerId: "demo-computer",
    agents: [],
    events: [],
  });

  await runHostCommand(
    { command: "status" },
    {
      readState,
      tokenBudget: () => null,
      recordTimeline: true,
      timelinePath,
      now: () => new Date("2026-06-02T00:00:03.000Z"),
    },
  );

  const timeline = await runHostCommand(
    {
      command: "timeline",
      input: { limit: 5 },
    },
    {
      timelinePath,
    },
  );
  assert.equal(timeline.ok, true);
  assert.match(timeline.text, /status ok exit=0/);
  assert.equal((timeline.json as { events?: Array<{ command?: string }> }).events?.[0]?.command, "status");
});

test("runHostCommand plans and writes host exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-command-export-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "result.txt"), "done", "utf8");

  const plan = await runHostCommand({
    command: "plan-export",
    input: { workspaceRoot: workspace, outputDir: join(root, "out"), runId: "run-1" },
  });
  assert.equal(plan.ok, true);
  assert.equal((plan.json as { workspaceFileCount?: number }).workspaceFileCount, 1);

  const blocked = await runHostCommand({
    command: "export",
    input: { workspaceRoot: workspace, outputDir: join(root, "out"), runId: "run-1" },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 75);
  assert.match(blocked.text, /confirmation required/);

  const exported = await runHostCommand({
    command: "export",
    input: { workspaceRoot: workspace, outputDir: join(root, "out"), runId: "run-1", confirmed: true },
  });
  assert.equal(exported.ok, true);
  const writtenFiles = (exported.json as { writtenFiles?: string[] }).writtenFiles ?? [];
  assert.equal(
    writtenFiles.some((file) => file.endsWith("workspace")),
    true,
  );
  assert.equal(
    writtenFiles.some((file) => file.endsWith("meta.json")),
    true,
  );
});

test("runHostCommand returns status, usage, events, and doctor results", async () => {
  const readState = async () => ({
    version: "0.1.0",
    pid: 123,
    startedAt: "2026-06-02T00:00:00.000Z",
    computerId: "demo-computer",
    agents: [
      {
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
          totalTokens: 15,
        },
        updatedAt: "2026-06-02T00:00:01.000Z",
      },
    ],
    events: [{ at: "2026-06-02T00:00:02.000Z", kind: "agent.started", detail: "demo-agent" }],
  });

  const usagePricing = () => [
    {
      key: "codex:*",
      currency: "USD",
      inputPerMillionTokens: 2,
      outputPerMillionTokens: 10,
    },
  ];
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
  assert.equal((usage.json as { runtimeData?: { schemaVersion?: number } }).runtimeData?.schemaVersion, 1);
  assert.equal(
    (usage.json as { runtimeData?: { providerCapabilities?: unknown[] } }).runtimeData?.providerCapabilities?.length,
    4,
  );

  const expenses = await runHostCommand({ command: "expenses" }, { readState, tokenBudget: () => 100, usagePricing });
  assert.equal(expenses.ok, true);
  assert.match(expenses.text, /usage expenses:/);
  assert.match(expenses.text, /demo-agent \(Demo Agent\): USD 0\.000070/);
  assert.equal(
    (expenses.json as { expenses?: Array<{ agentId?: string; amount?: number }> }).expenses?.[0]?.agentId,
    "demo-agent",
  );
  assert.equal((expenses.json as { expenses?: Array<{ amount?: number }> }).expenses?.[0]?.amount, 0.00007);

  const events = await runHostCommand({ command: "events" }, { readState, tokenBudget: () => null });
  assert.equal(events.ok, true);
  assert.match(events.text, /agent.started demo-agent/);

  const policy = await runHostCommand({ command: "policy", input: { command: "export" } });
  assert.equal(policy.ok, false);
  assert.equal(policy.exitCode, 1);
  assert.match(policy.text, /confirmation required/);

  const doctor = await runHostCommand(
    { command: "doctor" },
    {
      collectDoctorResults: async () => [
        {
          id: "codex",
          installed: true,
          path: "codex",
          big: { ok: true },
          small: { ok: true },
        },
      ],
    },
  );
  assert.equal(doctor.ok, true);
  assert.match(doctor.text, /codex/);

  const plan = await runHostCommand(
    {
      command: "plan-run",
      input: {
        goal: "inspect the repo",
        options: { engine: "claude" },
      },
    },
    {
      availableEngines: () => ["claude"],
    },
  );
  assert.equal(plan.ok, true);
  assert.match(plan.text, /goal: inspect the repo/);
  assert.equal((plan.json as { spec?: { goal?: string } }).spec?.goal, "inspect the repo");

  const preflight = await runHostCommand(
    {
      command: "preflight",
      input: {
        goal: "inspect the repo",
        options: { engine: "claude" },
      },
    },
    {
      availableEngines: () => ["claude"],
    },
  );
  assert.equal(preflight.ok, true);
  assert.match(preflight.text, /ready: yes/);
});

test("runHostCommand materializes host run layouts only after confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-command-layout-"));
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".git"), { recursive: true });
  await mkdir(join(projectDir, "agents", "dev"), { recursive: true });
  await writeFile(join(projectDir, "agents", "dev", "AGENT.md"), "# Dev\n", "utf8");
  await writeFile(
    join(projectDir, "agents.json"),
    JSON.stringify({
      agents: [{ id: "dev", name: "Dev", engine: "codex" }],
      apiKey: "secret-key",
    }),
    "utf8",
  );

  const blocked = await runHostCommand(
    {
      command: "prepare-run-layout",
      input: {
        goal: "prepare layout",
        runId: "layout-1",
        projectDir,
        options: { outputDir: join(root, "out"), engine: "codex" },
      },
    },
    {
      availableEngines: () => ["codex"],
    },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 75);
  assert.match(blocked.text, /confirmation required/);

  const prepared = await runHostCommand(
    {
      command: "prepare-run-layout",
      input: {
        goal: "prepare layout",
        runId: "layout-1",
        projectDir,
        options: { outputDir: join(root, "out"), engine: "codex" },
        confirmation: "allow:prepare-run-layout",
      },
    },
    {
      availableEngines: () => ["codex"],
    },
  );
  assert.equal(prepared.ok, true);
  const json = prepared.json as {
    launchPlan?: {
      layout?: {
        configPath?: string;
        workspaceRoot?: string;
        collaborationPath?: string;
        tasksPath?: string;
        capsulesPath?: string;
        workflowPath?: string;
        feedbackPath?: string;
        exists?: boolean;
      };
    };
    writtenFiles?: string[];
  };
  assert.equal(json.launchPlan?.layout?.exists, true);
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("agents.json")),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("collaboration.json")),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("loop-events.ndjson")),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("results.tsv")),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.includes(`${join(".king-ai", "heartbeat.json")}`)),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("meta.json")),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("tasks.jsonl")),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("capsules.jsonl")),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("workflow.jsonl")),
    true,
  );
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("run-feedback.jsonl")),
    true,
  );
  const preparedConfig = await readFile(json.launchPlan!.layout!.configPath!, "utf8");
  assert.match(preparedConfig, /"workspaceRoot"/);
  assert.equal(preparedConfig.includes("secret-key"), false);
  assert.match(await readFile(json.launchPlan!.layout!.workspaceRoot! + "/dev/AGENT.md", "utf8"), /# Dev/);
  assert.equal((await readFile(json.launchPlan!.layout!.workspaceRoot! + "/dev/AGENT.md", "utf8")).trim(), "# Dev");
  assert.equal(await readFile(join(root, "out", "loop-events.ndjson"), "utf8"), "");
  const results = await readFile(join(root, "out", "results.tsv"), "utf8");
  assert.match(
    results,
    /^run_id\tloop\ttimestamp\tclassification\ttasks_created\ttasks_done\tartifacts_created\tpending_messages\tcompletion_rate\tnotes\n$/,
  );
  const heartbeat = JSON.parse(await readFile(join(root, "out", ".king-ai", "heartbeat.json"), "utf8")) as {
    schema?: string;
    status?: string;
    runId?: string;
    loopCount?: number;
    outputDir?: string;
  };
  assert.equal(heartbeat.schema, "king-ai.host-run-heartbeat.v1");
  assert.equal(heartbeat.status, "prepared");
  assert.equal(heartbeat.runId, "layout-1");
  assert.equal(heartbeat.loopCount, 0);
  assert.equal(heartbeat.outputDir, join(root, "out"));
  const meta = JSON.parse(await readFile(join(root, "out", "meta.json"), "utf8")) as {
    schema?: string;
    status?: string;
    runId?: string;
    actualLoops?: number;
    paths?: {
      workspaceRoot?: string;
      resultsPath?: string;
      heartbeatPath?: string;
      collaborationPath?: string;
      tasksPath?: string;
      capsulesPath?: string;
      workflowPath?: string;
      feedbackPath?: string;
    };
  };
  assert.equal(meta.schema, "king-ai.host-run-meta.v1");
  assert.equal(meta.status, "prepared");
  assert.equal(meta.runId, "layout-1");
  assert.equal(meta.actualLoops, 0);
  assert.equal(meta.paths?.workspaceRoot, json.launchPlan!.layout!.workspaceRoot);
  assert.equal(meta.paths?.resultsPath, join(root, "out", "results.tsv"));
  assert.equal(meta.paths?.heartbeatPath, join(root, "out", ".king-ai", "heartbeat.json"));
  assert.equal(meta.paths?.collaborationPath, json.launchPlan!.layout!.collaborationPath);
  assert.equal(meta.paths?.tasksPath, join(root, "out", "tasks.jsonl"));
  assert.equal(meta.paths?.capsulesPath, join(root, "out", "capsules.jsonl"));
  assert.equal(meta.paths?.workflowPath, join(root, "out", "workflow.jsonl"));
  assert.equal(meta.paths?.feedbackPath, join(root, "out", "run-feedback.jsonl"));
  assert.equal(await readFile(join(root, "out", "tasks.jsonl"), "utf8"), "");
  assert.equal(await readFile(join(root, "out", "capsules.jsonl"), "utf8"), "");
  assert.equal(await readFile(join(root, "out", "workflow.jsonl"), "utf8"), "");
  assert.equal(await readFile(join(root, "out", "run-feedback.jsonl"), "utf8"), "");
  const collaboration = JSON.parse(await readFile(json.launchPlan!.layout!.collaborationPath!, "utf8")) as {
    schema?: string;
    governance?: { mode?: string; securityBoundary?: boolean; appliesWhen?: string };
    team?: {
      roles?: Array<{ template?: string; responsibility?: string }>;
      routingPolicy?: { defaultMode?: string; capabilityFirst?: boolean };
      permissionPolicy?: {
        defaultDecision?: string;
        rules?: Array<{ role?: string; allow?: string[]; requireHumanDecision?: string[] }>;
      };
    };
    agents?: Array<{ id?: string; roleTemplate?: string }>;
    workflowObjects?: string[];
    taskRules?: {
      dependencyField?: string;
      localTaskCommands?: string[];
      routingModes?: string[];
      permissionRules?: Array<{ role?: string; allow?: string[] }>;
    };
    capsuleRules?: { requiredFields?: string[]; defaultReviewer?: string; localCapsuleCommands?: string[] };
    worktreePlans?: Array<{ agentId?: string; plans?: Array<{ branch?: string; command?: string }> }>;
    paths?: { tasksPath?: string; capsulesPath?: string; workflowPath?: string; feedbackPath?: string };
  };
  assert.equal(collaboration.schema, "king-ai.host-run-collaboration.v1");
  assert.equal(collaboration.governance?.mode, "opt-in");
  assert.equal(collaboration.governance?.securityBoundary, false);
  assert.match(collaboration.governance?.appliesWhen ?? "", /KING_AI_TEAM_ROLE/);
  assert.equal(collaboration.team?.routingPolicy?.capabilityFirst, true);
  assert.equal(collaboration.team?.permissionPolicy?.defaultDecision, "deny");
  assert.equal(
    collaboration.team?.permissionPolicy?.rules?.some(
      (rule) => rule.role === "ops" && rule.requireHumanDecision?.includes("deploy-release"),
    ),
    true,
  );
  assert.equal(
    collaboration.team?.roles?.some((role) => role.template === "builder" && Boolean(role.responsibility)),
    true,
  );
  assert.equal(
    collaboration.team?.roles?.some((role) => role.template === "builder"),
    true,
  );
  assert.deepEqual(collaboration.workflowObjects, ["initiative", "task", "handoff", "review", "decision", "artifact"]);
  assert.equal(collaboration.taskRules?.dependencyField, "dependsOn");
  assert.equal(collaboration.taskRules?.localTaskCommands?.includes("king-ai host agenda"), true);
  assert.equal(collaboration.taskRules?.routingModes?.includes("human-decision"), true);
  assert.equal(
    collaboration.taskRules?.permissionRules?.some(
      (rule) => rule.role === "planner" && rule.allow?.includes("assign-task"),
    ),
    true,
  );
  assert.equal(collaboration.capsuleRules?.defaultReviewer, "reviewer");
  assert.equal(collaboration.capsuleRules?.requiredFields?.includes("verificationCommands"), true);
  assert.equal(collaboration.capsuleRules?.localCapsuleCommands?.includes("king-ai host capsule-create"), true);
  assert.equal(collaboration.worktreePlans?.[0]?.plans?.[0]?.branch, "agent/dev");
  assert.match(collaboration.worktreePlans?.[0]?.plans?.[0]?.command ?? "", /git -C .* worktree add -B agent\/dev/);
  assert.equal(collaboration.paths?.tasksPath, json.launchPlan!.layout!.tasksPath);
  assert.equal(collaboration.paths?.capsulesPath, json.launchPlan!.layout!.capsulesPath);
  assert.equal(collaboration.paths?.workflowPath, json.launchPlan!.layout!.workflowPath);
  assert.equal(collaboration.paths?.feedbackPath, json.launchPlan!.layout!.feedbackPath);
  assert.match(prepared.text, /written files:/);

  await writeFile(
    join(root, "out", "loop-events.ndjson"),
    [
      JSON.stringify({
        type: "loop.classified",
        runId: "layout-1",
        loop: 1,
        classification: "productive",
        timestamp: "2026-06-02T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "queue.backlog",
        runId: "layout-1",
        loop: 1,
        agent: "feedback",
        pendingMessages: 2,
        timestamp: "2026-06-02T00:00:01.000Z",
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  const watched = await runHostCommand({
    command: "watch-run",
    input: {
      outputDir: join(root, "out"),
      type: "loop.classified",
    },
  });
  assert.equal(watched.ok, true);
  assert.match(watched.text, /productive/);
  assert.match(watched.text, /results: .*results\.tsv \(1 rows\)/);
  assert.equal((watched.json as { filteredEvents?: number; summary?: { productiveRate?: number } }).filteredEvents, 1);
  assert.equal((watched.json as { summary?: { productiveRate?: number } }).summary?.productiveRate, 100);
  assert.match(
    await readFile(join(root, "out", "results.tsv"), "utf8"),
    /layout-1\t1\t2026-06-02T00:00:00\.000Z\tproductive/,
  );
  const runResults = await runHostCommand({
    command: "run-results",
    input: {
      outputDir: join(root, "out"),
    },
  });
  assert.equal(runResults.ok, true);
  assert.equal((runResults.json as { rows?: unknown[] }).rows?.length, 1);
  assert.match(runResults.text, /^run_id\tloop\ttimestamp\tclassification/);
  const heartbeatRead = await runHostCommand({
    command: "run-heartbeat",
    input: {
      outputDir: join(root, "out"),
    },
  });
  assert.equal(heartbeatRead.ok, true);
  assert.match(heartbeatRead.text, /status: prepared/);
  assert.equal(
    (heartbeatRead.json as { heartbeat?: { status?: string; runId?: string } }).heartbeat?.status,
    "prepared",
  );
  assert.equal(
    (heartbeatRead.json as { heartbeat?: { status?: string; runId?: string } }).heartbeat?.runId,
    "layout-1",
  );
  const metaRead = await runHostCommand({
    command: "run-meta",
    input: {
      outputDir: join(root, "out"),
    },
  });
  assert.equal(metaRead.ok, true);
  assert.match(metaRead.text, /status: prepared/);
  assert.equal(
    (metaRead.json as { meta?: { status?: string; runId?: string; paths?: { heartbeatPath?: string } } }).meta?.status,
    "prepared",
  );
  assert.equal(
    (metaRead.json as { meta?: { status?: string; runId?: string; paths?: { heartbeatPath?: string } } }).meta?.runId,
    "layout-1",
  );
  assert.equal(
    (metaRead.json as { meta?: { status?: string; runId?: string; paths?: { heartbeatPath?: string } } }).meta?.paths
      ?.heartbeatPath,
    join(root, "out", ".king-ai", "heartbeat.json"),
  );

  const duplicate = await runHostCommand(
    {
      command: "prepare-run-layout",
      input: {
        goal: "prepare layout",
        runId: "layout-1",
        projectDir,
        options: { outputDir: join(root, "out"), engine: "codex" },
        confirmation: "allow:prepare-run-layout",
      },
    },
    {
      availableEngines: () => ["codex"],
    },
  );
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error ?? duplicate.text, /already exists/);
});

test("prepare-run-layout creates King AI default agents and missing guides", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-command-default-layout-"));
  const prepared = await runHostCommand(
    {
      command: "prepare-run-layout",
      input: {
        goal: "prepare default layout",
        runId: "default-layout",
        options: { outputDir: join(root, "out"), engine: "claude" },
        confirmation: "allow:prepare-run-layout",
      },
    },
    {
      availableEngines: () => ["claude"],
    },
  );
  assert.equal(prepared.ok, true);
  const json = prepared.json as {
    launchPlan?: { layout?: { configPath?: string; workspaceRoot?: string; collaborationPath?: string } };
    writtenFiles?: string[];
  };
  const config = JSON.parse(await readFile(json.launchPlan!.layout!.configPath!, "utf8")) as {
    agents?: Array<{ id?: string; lifecycle?: string; tier?: string; engine?: string; systemPrompt?: string }>;
  };
  assert.deepEqual(
    config.agents?.map((agent) => agent.id),
    ["ceo", "dev", "cto", "tester", "devops", "feedback", "marketing"],
  );
  assert.equal(config.agents?.[0]?.lifecycle, "24/7");
  assert.equal(config.agents?.[0]?.tier, "high");
  assert.equal(config.agents?.[1]?.tier, "standard");
  assert.equal(config.agents?.[2]?.tier, "high");
  assert.equal(
    config.agents?.every((agent) => agent.engine === "claude"),
    true,
  );
  assert.match(config.agents?.find((agent) => agent.id === "cto")?.systemPrompt ?? "", /capsule acceptance criteria/);
  assert.match(config.agents?.find((agent) => agent.id === "dev")?.systemPrompt ?? "", /capsule-shaped handoff/);
  assert.match(
    await readFile(join(json.launchPlan!.layout!.workspaceRoot!, "ceo", "AGENT.md"), "utf8"),
    /Turn the run goal/,
  );
  assert.match(
    await readFile(join(json.launchPlan!.layout!.workspaceRoot!, "dev", "AGENT.md"), "utf8"),
    /private branch or worktree/,
  );
  assert.match(
    await readFile(join(json.launchPlan!.layout!.workspaceRoot!, "dev", "AGENT.md"), "utf8"),
    /acceptance evidence/,
  );
  assert.match(
    await readFile(join(json.launchPlan!.layout!.workspaceRoot!, "feedback", "AGENT.md"), "utf8"),
    /Review outputs/,
  );
  const collaboration = JSON.parse(await readFile(json.launchPlan!.layout!.collaborationPath!, "utf8")) as {
    agents?: Array<{ id?: string }>;
    capsuleRules?: { requiredFields?: string[] };
  };
  assert.deepEqual(
    collaboration.agents?.map((agent) => agent.id),
    ["ceo", "dev", "cto", "tester", "devops", "feedback", "marketing"],
  );
  assert.equal(collaboration.capsuleRules?.requiredFields?.includes("allowedPaths"), true);
  assert.equal(
    json.writtenFiles?.some((file) => file.endsWith("ceo/AGENT.md")),
    true,
  );
});

test("prepare-run-layout supports compact role profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-command-profile-layout-"));
  const prepared = await runHostCommand(
    {
      command: "prepare-run-layout",
      input: {
        goal: "prepare small layout",
        runId: "small-layout",
        roleProfile: "small",
        options: { outputDir: join(root, "out"), engine: "codex" },
        confirmation: "allow:prepare-run-layout",
      },
    },
    {
      availableEngines: () => ["codex"],
    },
  );
  assert.equal(prepared.ok, true);
  const json = prepared.json as { launchPlan?: { layout?: { configPath?: string; workspaceRoot?: string } } };
  const config = JSON.parse(await readFile(json.launchPlan!.layout!.configPath!, "utf8")) as {
    agents?: Array<{ id?: string; roleTemplate?: string }>;
  };
  assert.deepEqual(
    config.agents?.map((agent) => agent.id),
    ["ceo", "dev", "cto"],
  );
  assert.deepEqual(
    config.agents?.map((agent) => agent.roleTemplate),
    ["planner", "builder", "reviewer"],
  );
  assert.match(
    await readFile(join(json.launchPlan!.layout!.workspaceRoot!, "cto", "AGENT.md"), "utf8"),
    /Review architecture-sensitive changes/,
  );
});

test("runHostCommand persists and lists pending host run requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-command-runs-"));
  const runsPath = join(root, "host-runs.ndjson");
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".git"), { recursive: true });

  const submitted = await runHostCommand(
    {
      command: "submit-run",
      input: {
        goal: "review this repo",
        requestId: "app-request-1",
        projectDir,
        options: { engine: "codex", outputDir: join(root, "request-out") },
      },
    },
    {
      runsPath,
      availableEngines: () => ["codex"],
      now: () => new Date("2026-06-02T00:00:04.000Z"),
    },
  );
  assert.equal(submitted.ok, true);
  assert.match(submitted.text, /app-request-1 pending/);
  assert.equal((submitted.json as { request?: { id?: string; ready?: boolean } }).request?.id, "app-request-1");
  assert.equal((submitted.json as { request?: { id?: string; ready?: boolean } }).request?.ready, true);

  const listed = await runHostCommand(
    {
      command: "run-requests",
      input: { limit: 5 },
    },
    {
      runsPath,
    },
  );
  assert.equal(listed.ok, true);
  assert.match(listed.text, /review this repo/);
  assert.equal((listed.json as { requests?: Array<{ id?: string }> }).requests?.[0]?.id, "app-request-1");

  const single = await runHostCommand(
    {
      command: "run-request",
      input: { id: "app-request-1" },
    },
    {
      runsPath,
    },
  );
  assert.equal(single.ok, true);
  assert.equal((single.json as { request?: { id?: string; status?: string } }).request?.status, "pending");

  const running = await runHostCommand(
    {
      command: "update-run",
      input: { id: "app-request-1", status: "running", detail: "executor picked it up" },
    },
    {
      runsPath,
      now: () => new Date("2026-06-02T00:00:05.000Z"),
    },
  );
  assert.equal(running.ok, true);
  assert.match(running.text, /running/);
  assert.match(running.text, /executor picked it up/);
  const runningHeartbeat = JSON.parse(
    await readFile(join(root, "request-out", ".king-ai", "heartbeat.json"), "utf8"),
  ) as { status?: string; runId?: string; detail?: string; loopCount?: number };
  assert.equal(runningHeartbeat.status, "running");
  assert.equal(runningHeartbeat.runId, "app-request-1");
  assert.equal(runningHeartbeat.detail, "executor picked it up");
  assert.equal(runningHeartbeat.loopCount, 0);
  const runningMeta = JSON.parse(await readFile(join(root, "request-out", "meta.json"), "utf8")) as {
    status?: string;
    runId?: string;
    detail?: string;
    actualLoops?: number;
    updatedAt?: string;
  };
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

  const runningOnly = await runHostCommand(
    {
      command: "run-requests",
      input: { status: "running" },
    },
    {
      runsPath,
    },
  );
  assert.equal(
    (runningOnly.json as { requests?: Array<{ id?: string; status?: string }> }).requests?.[0]?.status,
    "running",
  );

  const cancelled = await runHostCommand(
    {
      command: "cancel-run",
      input: { id: "app-request-1", detail: "cancelled by app" },
    },
    {
      runsPath,
      now: () => new Date("2026-06-02T00:00:06.000Z"),
    },
  );
  assert.equal(cancelled.ok, true);
  assert.match(cancelled.text, /app-request-1 cancelled/);
  assert.match(cancelled.text, /cancelled by app/);
  const cancelledHeartbeat = JSON.parse(
    await readFile(join(root, "request-out", ".king-ai", "heartbeat.json"), "utf8"),
  ) as { status?: string; detail?: string };
  assert.equal(cancelledHeartbeat.status, "cancelled");
  assert.equal(cancelledHeartbeat.detail, "cancelled by app");
  const cancelledEvents = parseNdjson(await readFile(join(root, "request-out", "loop-events.ndjson"), "utf8"));
  assert.equal(cancelledEvents.at(-1)?.status, "cancelled");
  assert.equal(cancelledEvents.at(-1)?.source, "update-run");

  const missing = await runHostCommand(
    {
      command: "run-request",
      input: { id: "missing" },
    },
    {
      runsPath,
    },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.exitCode, 66);
});

test("runHostCommand executes safe pending host run requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-command-execute-"));
  const runsPath = join(root, "host-runs.ndjson");

  await runHostCommand(
    {
      command: "submit-run",
      input: {
        goal: "check status",
        requestId: "exec-request-1",
        options: { outputDir: join(root, "exec-out") },
        executor: {
          kind: "host-command",
          command: "status",
          format: "json",
        },
      },
    },
    {
      runsPath,
      availableEngines: () => ["codex"],
      now: () => new Date("2026-06-02T00:00:04.000Z"),
    },
  );

  const executed = await runHostCommand(
    {
      command: "execute-run",
      input: { id: "exec-request-1" },
    },
    {
      runsPath,
      readState: async () => ({
        version: "0.1.0",
        pid: 123,
        startedAt: "2026-06-02T00:00:00.000Z",
        computerId: "demo-computer",
        agents: [],
        events: [],
      }),
      tokenBudget: () => null,
      now: () => new Date("2026-06-02T00:00:05.000Z"),
    },
  );
  assert.equal(executed.ok, true);
  assert.match(executed.text, /completed/);
  assert.equal(
    (executed.json as { request?: { status?: string; result?: { command?: string } } }).request?.status,
    "completed",
  );
  assert.equal(
    (executed.json as { request?: { status?: string; result?: { command?: string } } }).request?.result?.command,
    "status",
  );
  const completedHeartbeat = JSON.parse(
    await readFile(join(root, "exec-out", ".king-ai", "heartbeat.json"), "utf8"),
  ) as { status?: string; runId?: string; command?: string; exitCode?: number; loopCount?: number };
  assert.equal(completedHeartbeat.status, "completed");
  assert.equal(completedHeartbeat.runId, "exec-request-1");
  assert.equal(completedHeartbeat.command, "status");
  assert.equal(completedHeartbeat.exitCode, 0);
  assert.equal(completedHeartbeat.loopCount, 1);
  const completedMeta = JSON.parse(await readFile(join(root, "exec-out", "meta.json"), "utf8")) as {
    status?: string;
    runId?: string;
    command?: string;
    exitCode?: number;
    actualLoops?: number;
    completedAt?: string;
  };
  assert.equal(completedMeta.status, "completed");
  assert.equal(completedMeta.runId, "exec-request-1");
  assert.equal(completedMeta.command, "status");
  assert.equal(completedMeta.exitCode, 0);
  assert.equal(completedMeta.actualLoops, 1);
  assert.equal(completedMeta.completedAt, "2026-06-02T00:00:05.000Z");
  const completedEvents = parseNdjson(await readFile(join(root, "exec-out", "loop-events.ndjson"), "utf8"));
  assert.deepEqual(
    completedEvents.map((event) => event.status),
    ["running", "completed"],
  );
  assert.deepEqual(
    completedEvents.map((event) => event.source),
    ["execute-run", "execute-run"],
  );
  assert.deepEqual(
    completedEvents.map((event) => event.loop),
    [0, 1],
  );

  await runHostCommand(
    {
      command: "submit-run",
      input: {
        goal: "try export",
        requestId: "exec-request-2",
        options: { outputDir: join(root, "blocked-out") },
        executor: {
          kind: "host-command",
          command: "export",
        },
      },
    },
    {
      runsPath,
      availableEngines: () => ["codex"],
    },
  );
  const blocked = await runHostCommand(
    {
      command: "execute-run",
      input: { id: "exec-request-2" },
    },
    {
      runsPath,
    },
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /not allowed/);
  assert.equal((blocked.json as { request?: { status?: string } }).request?.status, "failed");
  const failedHeartbeat = JSON.parse(
    await readFile(join(root, "blocked-out", ".king-ai", "heartbeat.json"), "utf8"),
  ) as { status?: string; runId?: string; command?: string; exitCode?: number; loopCount?: number };
  assert.equal(failedHeartbeat.status, "failed");
  assert.equal(failedHeartbeat.runId, "exec-request-2");
  assert.equal(failedHeartbeat.command, "export");
  assert.equal(failedHeartbeat.exitCode, 64);
  assert.equal(failedHeartbeat.loopCount, 0);
  const failedMeta = JSON.parse(await readFile(join(root, "blocked-out", "meta.json"), "utf8")) as {
    status?: string;
    runId?: string;
    command?: string;
    exitCode?: number;
    actualLoops?: number;
  };
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

test("safe host run executor enforces the submitting team role", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-host-executor-role-"));
  const runsPath = join(root, "host-runs.ndjson");

  const submitted = await runHostCommand(
    {
      command: "submit-run",
      actorRole: "ops",
      input: {
        goal: "inspect usage",
        requestId: "role-exec-1",
        options: { outputDir: join(root, "role-out") },
        executor: {
          kind: "host-command",
          command: "usage",
          format: "json",
        },
      },
    },
    {
      runsPath,
      availableEngines: () => ["codex"],
    },
  );
  assert.equal(submitted.ok, true);
  assert.equal(
    (submitted.json as { request?: { executor?: { actorRole?: string } } }).request?.executor?.actorRole,
    "ops",
  );

  const executed = await runHostCommand(
    {
      command: "execute-run",
      input: { id: "role-exec-1" },
    },
    {
      runsPath,
      readState: async () => null,
      tokenBudget: () => null,
      teamSpec: () => ({
        id: "queue-only",
        name: "Queue Only",
        roles: [],
        routingPolicy: { defaultMode: "one-of-us", capabilityFirst: true, reviewRequiredFor: [], humanDecisionFor: [] },
        permissionPolicy: { defaultDecision: "deny", rules: [{ role: "ops", allow: ["manage-queue"] }] },
      }),
    },
  );
  assert.equal(executed.ok, false);
  assert.equal(
    (
      executed.json as {
        commandResult?: {
          error?: string;
          json?: { permission?: { role?: string; action?: string; decision?: string } };
        };
      }
    ).commandResult?.error,
    "host command blocked by role governance",
  );
  assert.equal(
    (executed.json as { commandResult?: { json?: { permission?: { role?: string } } } }).commandResult?.json?.permission
      ?.role,
    "ops",
  );
  assert.equal(
    (executed.json as { commandResult?: { json?: { permission?: { action?: string } } } }).commandResult?.json
      ?.permission?.action,
    "view-cost",
  );
  assert.equal(
    (executed.json as { commandResult?: { json?: { permission?: { decision?: string } } } }).commandResult?.json
      ?.permission?.decision,
    "deny",
  );
  assert.equal(
    (executed.json as { request?: { status?: string; result?: { exitCode?: number } } }).request?.status,
    "failed",
  );
  assert.equal((executed.json as { request?: { result?: { exitCode?: number } } }).request?.result?.exitCode, 77);
});

test("runHostCommand rejects unsupported actions", async () => {
  const result = await runHostCommand({ command: "restart" });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 64);
  assert.match(result.text, /unsupported host command/);
});

function parseNdjson(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
