import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HOST_LOOP_RESULTS_HEADER } from "./host-loop-events.js";
import { writeHostRunHeartbeat } from "./host-run-heartbeat.js";
import type { HostLaunchPlan, HostRunSpecInput } from "./host-run-spec.js";
import { createHostLaunchPlan, formatHostLaunchPlanSummary, toJsonSafeHostLaunchPlan } from "./host-run-spec.js";

export interface HostRunLayoutInput extends HostRunSpecInput {
  force?: boolean;
}

export interface HostRunLayoutResult {
  launchPlan: ReturnType<typeof toJsonSafeHostLaunchPlan>;
  writtenFiles: string[];
  copiedDirectories: string[];
  summary: string;
}

export async function prepareHostRunLayout(
  input: HostRunLayoutInput,
  options: {
    env?: NodeJS.ProcessEnv;
    availableEngines?: Array<"claude" | "codex">;
  } = {}
): Promise<HostRunLayoutResult> {
  const launchPlan = createHostLaunchPlan(input, options.env ?? process.env, options.availableEngines);
  if (!launchPlan.ready) {
    throw new Error("host run layout is not ready; run preflight and resolve errors first");
  }
  if (launchPlan.layout.exists && !input.force) {
    throw new Error(`host run layout already exists: ${launchPlan.layout.baseDir}`);
  }

  if (launchPlan.layout.exists && input.force) {
    await rm(launchPlan.layout.baseDir, { recursive: true, force: true });
  }

  const writtenFiles: string[] = [];
  const copiedDirectories: string[] = [];
  await mkdir(launchPlan.layout.baseDir, { recursive: true });
  await mkdir(dirname(launchPlan.layout.configPath), { recursive: true });
  await mkdir(launchPlan.layout.workspaceRoot, { recursive: true });
  await mkdir(launchPlan.layout.sharedSkillsDir, { recursive: true });
  await mkdir(launchPlan.layout.outputDir, { recursive: true });
  await writeFile(launchPlan.layout.configPath, await buildLocalizedAgentConfig(launchPlan), "utf8");
  writtenFiles.push(launchPlan.layout.configPath);

  if (launchPlan.spec.projectDir) {
    const projectAgents = join(launchPlan.spec.projectDir, "agents");
    if (existsSync(projectAgents)) {
      await copyDirectoryContents(projectAgents, launchPlan.layout.workspaceRoot);
      copiedDirectories.push(projectAgents);
    }
    const projectSkills = join(launchPlan.spec.projectDir, "skills");
    if (existsSync(projectSkills)) {
      await copyDirectoryContents(projectSkills, launchPlan.layout.sharedSkillsDir);
      copiedDirectories.push(projectSkills);
    }
  }
  for (const file of await writeMissingAgentGuides(launchPlan)) writtenFiles.push(file);
  for (const file of await writeRunObservationFiles(launchPlan, input.force === true)) writtenFiles.push(file);

  return {
    launchPlan: toJsonSafeHostLaunchPlan({
      ...launchPlan,
      layout: {
        ...launchPlan.layout,
        exists: true
      },
      launchSummary: formatHostLaunchPlanSummary({
        ...launchPlan,
        layout: {
          ...launchPlan.layout,
          exists: true
        }
      })
    }),
    writtenFiles,
    copiedDirectories,
    summary: formatHostRunLayoutResult(launchPlan, writtenFiles, copiedDirectories)
  };
}

export function formatHostRunLayoutResult(plan: HostLaunchPlan, writtenFiles: string[], copiedDirectories: string[]): string {
  return [
    `prepared host run layout: ${plan.runId}`,
    `base: ${plan.layout.baseDir}`,
    `config: ${plan.layout.configPath}`,
    `workspace: ${plan.layout.workspaceRoot}`,
    `shared skills: ${plan.layout.sharedSkillsDir}`,
    `git root: ${plan.layout.gitRoot}`,
    `written files: ${writtenFiles.length ? writtenFiles.join(", ") : "(none)"}`,
    copiedDirectories.length ? `copied directories: ${copiedDirectories.join(", ")}` : "copied directories: (none)"
  ].join("\n");
}

async function buildLocalizedAgentConfig(plan: HostLaunchPlan): Promise<string> {
  const raw = plan.config.path && plan.config.exists
    ? await readFile(plan.config.path, "utf8")
    : createDefaultHostRunConfigText(plan);
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`host run config must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  config.workspaceRoot = plan.layout.workspaceRoot;
  config.gitRoot = plan.layout.gitRoot;
  config.outputDir = plan.layout.outputDir;
  config.layoutSchema = "king.host-run-layout.v1";
  redactConfigSecrets(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function writeRunObservationFiles(plan: HostLaunchPlan, force: boolean): Promise<string[]> {
  const written: string[] = [];
  if (force || !existsSync(plan.layout.loopEventsPath)) {
    await writeFile(plan.layout.loopEventsPath, "", "utf8");
    written.push(plan.layout.loopEventsPath);
  }
  if (force || !existsSync(plan.layout.resultsPath)) {
    await writeFile(plan.layout.resultsPath, HOST_LOOP_RESULTS_HEADER, "utf8");
    written.push(plan.layout.resultsPath);
  }
  if (force || !existsSync(plan.layout.heartbeatPath)) {
    await writeHostRunHeartbeat({
      path: plan.layout.heartbeatPath,
      runId: plan.runId,
      status: "prepared",
      outputDir: plan.layout.outputDir
    });
    written.push(plan.layout.heartbeatPath);
  }
  if (force || !existsSync(plan.layout.metaPath)) {
    await writeFile(plan.layout.metaPath, `${JSON.stringify(createPreparedRunMeta(plan), null, 2)}\n`, "utf8");
    written.push(plan.layout.metaPath);
  }
  return written;
}

function createPreparedRunMeta(plan: HostLaunchPlan): Record<string, unknown> {
  return {
    schema: "king.host-run-meta.v1",
    status: "prepared",
    runId: plan.runId,
    goal: plan.spec.goal,
    preparedAt: new Date().toISOString(),
    maxLoops: plan.options.loopMode === "infinite" ? "infinite" : plan.options.loops,
    actualLoops: 0,
    session: plan.session,
    paths: {
      baseDir: plan.layout.baseDir,
      configPath: plan.layout.configPath,
      workspaceRoot: plan.layout.workspaceRoot,
      sharedSkillsDir: plan.layout.sharedSkillsDir,
      gitRoot: plan.layout.gitRoot,
      outputDir: plan.layout.outputDir,
      loopEventsPath: plan.layout.loopEventsPath,
      resultsPath: plan.layout.resultsPath,
      heartbeatPath: plan.layout.heartbeatPath,
      metaPath: plan.layout.metaPath
    },
    config: {
      source: plan.config.source,
      label: plan.config.label
    }
  };
}

export function createDefaultHostRunConfigText(plan: HostLaunchPlan): string {
  const engine = plan.effectiveEngine ?? plan.options.engine;
  const agents = [
    defaultHostRunAgent(plan, "ceo", "CEO", "24/7", "high", "Turn the run goal into a small backlog, assign work, review progress, and produce a concise final deliverable."),
    defaultHostRunAgent(plan, "dev", "Dev", "on-demand", "standard", "Implement assigned code, docs, or analysis tasks end-to-end and report exact files or outputs changed."),
    defaultHostRunAgent(plan, "feedback", "Feedback", "on-demand", "standard", "Review outputs, identify gaps, and convert useful observations into concrete follow-up tasks.")
  ].map((agent) => ({
    ...agent,
    ...(engine ? { engine } : {}),
    ...(plan.options.model && agent.id === "ceo" ? { model: plan.options.model } : {}),
    ...(plan.options.fastModel && agent.id !== "ceo" ? { model: plan.options.fastModel } : {})
  }));
  return JSON.stringify({
    agents,
    workspaceRoot: plan.layout.workspaceRoot,
    gitRoot: plan.layout.gitRoot,
    outputDir: plan.layout.outputDir,
    layoutSchema: "king.host-run-layout.v1"
  }, null, 2);
}

function defaultHostRunAgent(
  plan: HostLaunchPlan,
  id: string,
  name: string,
  lifecycle: "24/7" | "on-demand",
  tier: "high" | "standard",
  role: string
) {
  return {
    id,
    name,
    role,
    lifecycle,
    tier,
    systemPrompt: `${role}\n\n${defaultHostRunCliInstructions(plan)}`
  };
}

function defaultHostRunCliInstructions(plan: HostLaunchPlan): string {
  return [
    "Use `king recv` for messages, `king task list` for work state, and `king send <agent> \"<message>\"` to coordinate.",
    "Use `king send human --type decision \"<question>\"` when a human choice is required.",
    `Keep outputs under ${plan.layout.outputDir} unless the task explicitly asks for repository changes.`
  ].join("\n");
}

async function writeMissingAgentGuides(plan: HostLaunchPlan): Promise<string[]> {
  let agents: Array<{ id?: unknown; name?: unknown; role?: unknown; systemPrompt?: unknown }> = [];
  try {
    const config = JSON.parse(await readFile(plan.layout.configPath, "utf8")) as { agents?: unknown };
    if (Array.isArray(config.agents)) agents = config.agents as typeof agents;
  } catch {
    return [];
  }
  const written: string[] = [];
  for (const agent of agents) {
    const id = typeof agent.id === "string" && agent.id.trim()
      ? agent.id.trim()
      : typeof agent.name === "string" && agent.name.trim()
        ? agent.name.trim()
        : undefined;
    if (!id) continue;
    const agentDir = join(plan.layout.workspaceRoot, id);
    const guidePath = join(agentDir, "AGENT.md");
    if (existsSync(guidePath)) continue;
    await mkdir(agentDir, { recursive: true });
    await writeFile(guidePath, defaultAgentGuideText(agent, plan), "utf8");
    written.push(guidePath);
  }
  return written;
}

function defaultAgentGuideText(agent: { id?: unknown; name?: unknown; role?: unknown; systemPrompt?: unknown }, plan: HostLaunchPlan): string {
  const name = typeof agent.name === "string" && agent.name.trim()
    ? agent.name.trim()
    : typeof agent.id === "string" && agent.id.trim()
      ? agent.id.trim()
      : "Agent";
  const role = typeof agent.systemPrompt === "string" && agent.systemPrompt.trim()
    ? agent.systemPrompt.trim()
    : typeof agent.role === "string" && agent.role.trim()
      ? agent.role.trim()
      : "Work through assigned local run tasks and report concrete results.";
  return [
    `# ${name}`,
    "",
    role,
    "",
    "## Operating Rules",
    "",
    "- Read current messages with `king recv` before starting new work.",
    "- Check assigned work with `king task list` and update the team through `king send`.",
    `- Put files you create under ${plan.layout.outputDir} unless the task explicitly asks for repository changes.`
  ].join("\n") + "\n";
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir)) {
    await cp(join(sourceDir, entry), join(targetDir, entry), {
      recursive: true,
      force: true,
      dereference: false
    });
  }
}

function redactConfigSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (/^(apiKey|api_key|token|secret|password)$/i.test(key)) {
      delete (value as Record<string, unknown>)[key];
      continue;
    }
    redactConfigSecrets((value as Record<string, unknown>)[key]);
  }
}
