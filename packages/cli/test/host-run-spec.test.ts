import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createDefaultHostRunOptions, createHostLaunchPlan, createHostRunPlan, formatHostRunPlanSummary, parseHostGitStatus, toJsonSafeHostLaunchPlan } from "../src/host-run-spec.js";

test("createDefaultHostRunOptions normalizes bounded and infinite loops", () => {
  const defaults = createDefaultHostRunOptions();
  assert.equal(defaults.loops, 100);
  assert.equal(defaults.pollIntervalSeconds, 15);
  assert.equal(defaults.loopMode, "bounded");
  assert.equal(defaults.outputDir, resolve("deliverables"));
  assert.equal(defaults.workerKey, "lmstudio");
  assert.equal(defaults.noBrain, false);

  const infinite = createDefaultHostRunOptions({ loopMode: "infinite", loops: 3 });
  assert.equal(infinite.loopMode, "infinite");
  assert.equal(infinite.loops, Infinity);
});

test("toJsonSafeHostLaunchPlan keeps infinite loops JSON-safe", () => {
  const plan = createHostLaunchPlan({
    goal: "watch forever",
    options: { loopMode: "infinite" }
  }, {}, ["codex"]);
  const json = toJsonSafeHostLaunchPlan(plan);
  assert.equal(json.options.loopMode, "infinite");
  assert.equal(json.options.loops, "infinite");
  assert.equal(JSON.stringify(json).includes("null"), false);
});

test("createHostRunPlan validates local project dirs and renders a summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-host-run-"));
  await writeFile(join(dir, "package.json"), "{}", "utf8");

  const plan = createHostRunPlan({
    goal: "review this repo",
    projectDir: dir,
    options: {
      engine: "codex",
      model: "gpt-test",
      loops: 2,
      outputDir: "out"
    }
  }, {
    KING_AGENT_WORKSPACE_ROOT: join(dir, ".agents")
  } as NodeJS.ProcessEnv);

  assert.match(plan.runId, /^host-run-/);
  assert.equal(plan.spec.goal, "review this repo");
  assert.equal(plan.spec.projectDir, dir);
  assert.equal(plan.spec.repoSourceDir, dir);
  assert.equal(plan.spec.gitRoot, dir);
  assert.equal(plan.spec.workspaceRoot, join(dir, ".agents"));
  assert.equal(plan.options.engine, "codex");
  assert.equal(plan.options.model, "gpt-test");
  assert.equal(plan.options.loops, 2);
  assert.match(formatHostRunPlanSummary(plan), /host run: run project:/);
});

test("createHostRunPlan accepts King project run metadata without leaking secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-host-project-spec-"));
  await writeFile(join(dir, "package.json"), "{}", "utf8");

  const plan = createHostRunPlan({
    goal: "sync threaded project",
    projectDir: dir,
    githubToken: "ghp_secret",
    threadSync: {
      threadId: "thread-1",
      syncUrl: "https://sync.example/thread-1",
      syncSecret: "sync-secret"
    },
    hooks: {
      beforeRun: "prepare"
    }
  });

  assert.equal(plan.spec.githubToken, "ghp_secret");
  assert.equal(plan.spec.threadSync?.threadId, "thread-1");
  assert.equal(plan.spec.threadSync?.syncSecret, "sync-secret");
  assert.deepEqual(plan.spec.hooks, { beforeRun: "prepare" });
  assert.match(plan.summary, /thread sync: thread-1/);
  assert.equal(plan.summary.includes("ghp_secret"), false);
  assert.equal(plan.summary.includes("sync-secret"), false);
});

test("createHostRunPlan accepts King worker run options without leaking worker keys", () => {
  const plan = createHostRunPlan({
    goal: "run with local worker",
    options: {
      configPath: "config.json",
      workerUrl: " http://127.0.0.1:1234 ",
      workerModel: " local-model ",
      workerKey: "worker-secret-key",
      noBrain: true
    }
  });

  assert.equal(plan.options.configPath, "config.json");
  assert.equal(plan.options.workerUrl, "http://127.0.0.1:1234");
  assert.equal(plan.options.workerModel, "local-model");
  assert.equal(plan.options.workerKey, "worker-secret-key");
  assert.equal(plan.options.noBrain, true);
  assert.match(plan.summary, /brain: disabled/);
  assert.match(plan.summary, /worker=configured/);
  assert.match(plan.summary, /workerModel=local-model/);
  assert.equal(plan.summary.includes("worker-secret-key"), false);
});

test("createHostRunPlan rejects run IDs that are not safe filename segments", () => {
  assert.throws(
    () => createHostRunPlan({ goal: "unsafe run", runId: "../../outside" }),
    /runId must be a safe filename segment/
  );
  assert.throws(
    () => createHostRunPlan({ goal: "unsafe run", runId: "nested/run" }),
    /runId must be a safe filename segment/
  );

  const plan = createHostLaunchPlan({
    goal: "safe run",
    runId: "safe-run_1.2",
    options: { outputDir: "out" }
  }, {}, ["codex"]);
  assert.equal(plan.runId, "safe-run_1.2");
  assert.equal(plan.layout.baseDir, join(plan.options.outputDir, ".king-local", "safe-run_1.2"));
});

test("createHostLaunchPlan reports launch readiness and preflight issues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-host-launch-"));
  await writeFile(join(dir, "package.json"), "{}", "utf8");
  await writeFile(join(dir, "agents.json"), "{\"agents\":[]}", "utf8");
  await writeFile(join(dir, ".env"), "DB9_TOKEN=secret-token\n", "utf8");

  const ready = createHostLaunchPlan({
    goal: "ship feature",
    projectDir: dir,
    options: { engine: "codex" }
  }, {}, ["codex"]);
  assert.equal(ready.ready, true);
  assert.equal(ready.effectiveEngine, "codex");
  assert.equal(ready.session.runtimeLabel, "codex");
  assert.equal(ready.session.llmModeLabel, "codex-cli");
  assert.equal(ready.session.codexConfigLabel, "default / default");
  assert.equal(ready.environment.envFilePath, join(dir, ".env"));
  assert.equal(ready.environment.envFileExists, true);
  assert.equal(ready.environment.envLoading, "not-loaded");
  assert.equal(ready.launchSummary.includes("secret-token"), false);
  assert.match(ready.launchSummary, /environment: \.env present loading=not-loaded/);
  assert.equal(ready.config.label, "agents.json (project)");
  assert.equal(ready.config.source, "project");
  assert.equal(ready.config.path, join(dir, "agents.json"));
  assert.equal(ready.config.exists, true);
  assert.equal(ready.layout.baseDir, join(ready.options.outputDir, ".king-local", ready.runId));
  assert.equal(ready.layout.configPath, join(ready.layout.baseDir, "agents.json"));
  assert.equal(ready.layout.workspaceRoot, join(ready.layout.baseDir, "agents"));
  assert.equal(ready.layout.sharedSkillsDir, join(ready.layout.baseDir, "shared-skills"));
  assert.equal(ready.layout.gitRoot, dir);
  assert.equal(ready.layout.loopEventsPath, join(ready.options.outputDir, "loop-events.ndjson"));
  assert.equal(ready.layout.resultsPath, join(ready.options.outputDir, "results.tsv"));
  assert.equal(ready.layout.heartbeatPath, join(ready.options.outputDir, ".king", "heartbeat.json"));
  assert.equal(ready.layout.metaPath, join(ready.options.outputDir, "meta.json"));
  assert.equal(ready.layout.collaborationPath, join(ready.layout.baseDir, "collaboration.json"));
  assert.equal(ready.layout.tasksPath, join(ready.options.outputDir, "tasks.jsonl"));
  assert.equal(ready.layout.capsulesPath, join(ready.options.outputDir, "capsules.jsonl"));
  assert.equal(ready.layout.feedbackPath, join(ready.options.outputDir, "run-feedback.jsonl"));
  assert.equal(ready.layout.sourceConfigPath, join(dir, "agents.json"));
  assert.equal(ready.layout.exists, false);
  assert.deepEqual(ready.availableEngines, ["codex"]);
  assert.match(ready.launchSummary, /session: codex-cli runtime=codex codex=default \/ default/);
  assert.match(ready.launchSummary, /config: agents\.json \(project\) source=project exists=yes/);
  assert.match(ready.launchSummary, /layout: .*\.king-local.* exists=no/);
  assert.match(ready.launchSummary, /workspace: .*\.king-local.*agents/);
  assert.match(ready.launchSummary, /ready: yes/);
  assert.match(ready.launchSummary, /warning\/project-not-git/);
  assert.match(ready.suggestedCommands.join("\n"), /king project-profile/);

  const missingEngine = createHostLaunchPlan({
    goal: "ship feature",
    options: { engine: "claude" }
  }, {}, []);
  assert.equal(missingEngine.ready, false);
  assert.equal(missingEngine.issues[0]?.code, "no-engine");
  assert.equal(missingEngine.session.llmModeLabel, "claude-cli");
  assert.equal(missingEngine.config.label, "built-in-local-agents.json");
  assert.equal(missingEngine.config.source, "default");
  assert.equal(missingEngine.config.exists, true);
  assert.equal(missingEngine.layout.sourceConfigPath, undefined);
  assert.match(missingEngine.launchSummary, /ready: no/);
});

test("parseHostGitStatus reads branch, upstream, ahead/behind, and changed paths", () => {
  const state = parseHostGitStatus([
    "# branch.oid abc123",
    "# branch.head feature/demo",
    "# branch.upstream origin/feature/demo",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 abc abc src/app.ts",
    "2 R. N... 100644 100644 100644 abc abc R100 src/new.ts\tsrc/old.ts",
    "? notes/todo.md"
  ].join("\n"));

  assert.equal(state.activeBranch, "feature/demo");
  assert.equal(state.hasUpstream, true);
  assert.equal(state.branchAhead, 2);
  assert.equal(state.branchBehind, 1);
  assert.deepEqual(state.modifiedFiles, ["src/app.ts", "src/new.ts", "notes/todo.md"]);
});

test("createHostLaunchPlan exposes read-only local git observation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-host-git-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  await writeFile(join(dir, "package.json"), "{}", "utf8");

  const plan = createHostLaunchPlan({
    goal: "inspect git",
    projectDir: dir,
    options: { engine: "codex" }
  }, {}, ["codex"]);

  assert.equal(plan.git.isGitRepo, true);
  assert.equal(plan.git.gitRoot, dir);
  assert.equal(plan.git.branchAhead, 0);
  assert.equal(plan.git.branchBehind, 0);
  assert.equal(plan.git.modifiedFiles.includes("package.json"), true);
  assert.match(plan.launchSummary, /git: .*changed=1/);
});

test("createHostLaunchPlan exposes explicit configPath metadata without reading config content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-host-config-"));
  const configPath = join(dir, "custom-agents.json");
  await writeFile(configPath, "{\"agents\":[{\"systemPrompt\":\"secret prompt\"}]}", "utf8");

  const plan = createHostLaunchPlan({
    goal: "run with config",
    options: {
      configPath
    }
  }, {}, ["claude"]);

  assert.equal(plan.config.label, "custom-agents.json");
  assert.equal(plan.config.source, "explicit");
  assert.equal(plan.config.path, configPath);
  assert.equal(plan.config.exists, true);
  assert.equal(plan.layout.sourceConfigPath, configPath);
  assert.equal(plan.launchSummary.includes("secret prompt"), false);
});

test("createHostLaunchPlan reports local layout while honoring explicit workspace roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-host-layout-"));
  const workspaceRoot = join(dir, "custom-agents");
  const outputDir = join(dir, "out");

  const plan = createHostLaunchPlan({
    goal: "preview layout",
    projectDir: dir,
    workspaceRoot,
    options: {
      outputDir
    }
  }, {}, ["claude"]);

  assert.equal(plan.layout.outputDir, outputDir);
  assert.equal(plan.layout.baseDir, join(outputDir, ".king-local", plan.runId));
  assert.equal(plan.layout.workspaceRoot, workspaceRoot);
  assert.equal(plan.layout.sharedSkillsDir, join(plan.layout.baseDir, "shared-skills"));
  assert.equal(plan.layout.configPath, join(plan.layout.baseDir, "agents.json"));
  assert.equal(plan.layout.loopEventsPath, join(outputDir, "loop-events.ndjson"));
  assert.equal(plan.layout.resultsPath, join(outputDir, "results.tsv"));
  assert.equal(plan.layout.heartbeatPath, join(outputDir, ".king", "heartbeat.json"));
  assert.equal(plan.layout.metaPath, join(outputDir, "meta.json"));
  assert.equal(plan.layout.collaborationPath, join(plan.layout.baseDir, "collaboration.json"));
  assert.equal(plan.layout.tasksPath, join(outputDir, "tasks.jsonl"));
  assert.equal(plan.layout.capsulesPath, join(outputDir, "capsules.jsonl"));
  assert.equal(plan.layout.feedbackPath, join(outputDir, "run-feedback.jsonl"));
  assert.equal(plan.launchSummary.includes(workspaceRoot), true);
});

test("createHostLaunchPlan accepts local role profiles", () => {
  const plan = createHostLaunchPlan({
    goal: "small team",
    roleProfile: "small"
  }, {}, ["codex"]);

  assert.equal(plan.spec.roleProfile, "small");
  assert.match(plan.summary, /role profile: small/);
});

test("createHostLaunchPlan exposes King hybrid worker session metadata", () => {
  const plan = createHostLaunchPlan({
    goal: "run hybrid",
    options: {
      engine: "codex",
      model: "gpt-test",
      codexReasoningEffort: "high",
      workerUrl: "http://127.0.0.1:1234"
    }
  }, {}, ["codex", "claude"]);

  assert.equal(plan.session.useHybrid, true);
  assert.equal(plan.session.runtimeOverride, "codex");
  assert.equal(plan.session.runtimeLabel, "codex");
  assert.equal(plan.session.llmModeLabel, "hybrid-worker");
  assert.equal(plan.session.modelOverride, "gpt-test");
  assert.equal(plan.session.codexReasoningEffort, "high");
  assert.equal(plan.session.codexConfigLabel, "gpt-test / high");
  assert.match(plan.launchSummary, /session: hybrid-worker runtime=codex codex=gpt-test \/ high/);
});

test("createHostLaunchPlan requires a source for takeover mode", () => {
  const plan = createHostLaunchPlan({ goal: "take over", mode: "takeover" }, {}, ["claude"]);
  assert.equal(plan.ready, false);
  assert.equal(plan.issues.some((issue) => issue.code === "takeover-source-required"), true);
});

test("createHostRunPlan rejects missing goals and invalid project dirs", () => {
  assert.throws(() => createHostRunPlan({ goal: "" }), /goal is required/);
  assert.throws(() => createHostRunPlan({ goal: "x", projectDir: "/path/that/does/not/exist" }), /projectDir does not exist/);
});
