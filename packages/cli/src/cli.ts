#!/usr/bin/env node
import { cli, command } from "cleye";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CURRENT_VERSION, DEFAULT_SERVER, normalizeCommandName } from "./paths.js";
import { doPair, doRun, runDoctor } from "./daemon.js";
import { cleanupWorktrees, installService, isServiceInstalled, prepareWorktrees, printStatus, readRunningState, reloadService, restartService, stopService, tailLogs, uninstallService, watchStatus } from "./service.js";
import type { CommandName } from "./paths.js";
import { runSkillCheck } from "./skill-check.js";
import { runProjectProfile } from "./project-profile.js";
import { formatUsageExpenses, formatUsageSummary, listUsageExpenses, summarizeAgentUsage, tokenBudgetFromEnv, usagePricingFromEnv } from "./usage.js";
import { buildUsageRuntimeData, formatProviderCapabilities, formatRuntimeResultsTable, writeUsageRuntimeData } from "./runtime-data.js";
import { buildHostStatusSnapshot, formatHostStatusSnapshot } from "./host-api.js";
import { listHostCommands, runHostCommand } from "./host-control.js";
import type { HostCommandRequest, HostCommandResult } from "./host-control.js";
import { DEFAULT_HOST_SERVER_HOST, hostServerPortFromEnv, serveHostStatus } from "./host-server.js";
import { scenarioTemplate } from "./team-workflow.js";
import type { KingScenarioTemplate } from "./team-workflow.js";
import type { EngineId } from "./types.js";

import { runRuleLoop } from "./trade/alert-rule.js";
import { runMorningBrief, type BriefSection } from "./trade/morning-brief.js";
import { createRuleAsync, listRuleIds } from "./trade/rules/registry.js";
import { runTradeDaemon } from "./trade/scheduler.js";

import { runProcessWatchdog } from "./trade/process-watchdog.js";
import { runTwitterCollector } from "./trade/twitter-collector.js";

import { runVerifySignalsPush } from "./trade/verify-signals.js";
import { runVerifyCelebrity } from "./trade/verify-celebrity.js";
import {
  installTradeService,
  killRunningTradeDaemons,
  printTradeServiceStatus,
  restartTradeService,
  tailTradeLogs,
  uninstallTradeService
} from "./trade/service.js";

const PREFERRED_ENGINES: EngineId[] = ["grok", "claude", "codex"];

function assertPreferredEngine(engine: EngineId | undefined): void {
  if (engine && !PREFERRED_ENGINES.includes(engine)) {
    throw new Error("--engine must be claude, codex, or grok");
  }
}

export function commandNameFromArgv(argv0?: string): CommandName {
  return normalizeCommandName(argv0);
}

export function versionText(commandName: string, version = CURRENT_VERSION): string {
  return `${commandName} ${version}`;
}

export function defaultServerForCommand(_commandName: string): string {
  return DEFAULT_SERVER;
}

export function hasExplicitServerArg(args: string[]): boolean {
  return args.some((arg) => arg === "--server" || arg.startsWith("--server="));
}

export function computerHelpText(defaultServer = DEFAULT_SERVER, commandName = "king-ai"): string {
  return [
    `${commandName} agent computer - run local BYOA agents on THIS machine`,
    "",
    "The daemon talks to a runtime server over HTTP and drives a local agent",
    "engine (Claude Code, Codex, or Grok). Pair once, then it can run in the background.",
    "",
    "Usage:",
    `  ${commandName} agent computer --pair <code> [--server <url>] [--engine <id>]`,
    `  ${commandName} agent computer [--server <url>] [--tenant <id>]`,
    "",
    "Setup:",
    "  --pair <code>        pair this machine with the runtime",
    `  --server <url>       runtime server URL (default: ${defaultServer})`,
    "  --tenant <id>        runtime tenant id on multi-tenant GUI servers",
    "  --engine <id>        force an engine: claude | codex | grok",
    "",
    "Background service:",
    "  --install-service    install + start the background supervisor",
    "  --uninstall-service  remove the background supervisor",
    "  --restart            restart the background service",
    "  --stop               stop the background service and foreground daemon",
    "  --status             show pairing + service status",
    "  --watch              watch running daemon state",
    "  --logs               tail daemon logs",
    "  --prepare-worktrees  show planned agent git worktrees from running state",
    "  --cleanup-worktrees  show removable agent git worktrees from running state",
    "  --yes                with --prepare-worktrees or --cleanup-worktrees, execute",
    "",
    "Diagnostics:",
    "  --doctor             check engines, PATH, login/quota",
    "  --version, -v        print the daemon version",
    "  --help, -h           show this help",
    "",
    "With no flags it starts the daemon in the foreground (must be paired first)."
  ].join("\n");
}

export function normalizeComputerArgs(args: string[]): string[] {
  const normalized = [...args];
  if (normalized[1] === "help") normalized[1] = "--help";
  if (normalized[1] === "doctor") normalized[1] = "--doctor";
  return normalized;
}

export function shouldRunAfterPair(serviceInstalled: boolean): boolean {
  return !serviceInstalled;
}

const computerCommand = command(
  {
    name: "computer",
    flags: {
      help: {
        type: Boolean,
        alias: "h",
        description: "Show help"
      },
      pair: {
        type: String,
        description: "Pairing code from the runtime server"
      },
      server: {
        type: String,
        description: "Runtime server URL",
        default: DEFAULT_SERVER
      },
      tenant: {
        type: String,
        description: "Runtime tenant id for multi-tenant GUI servers"
      },
      engine: {
        type: String,
        description: "Preferred local engine: claude, codex, or grok"
      },
      installService: {
        type: Boolean,
        description: "Install and start a background service"
      },
      uninstallService: {
        type: Boolean,
        description: "Remove the background service"
      },
      restart: {
        type: Boolean,
        description: "Restart the background service"
      },
      stop: {
        type: Boolean,
        description: "Stop the background service and tracked foreground daemon"
      },
      status: {
        type: Boolean,
        description: "Print pairing and service status"
      },
      logs: {
        type: Boolean,
        description: "Tail daemon logs"
      },
      watch: {
        type: Boolean,
        description: "Watch running daemon state"
      },
      prepareWorktrees: {
        type: Boolean,
        description: "Show or create planned git worktrees from running daemon state"
      },
      cleanupWorktrees: {
        type: Boolean,
        description: "Show or remove planned git worktrees from running daemon state"
      },
      yes: {
        type: Boolean,
        description: "Confirm creating or removing worktrees"
      },
      doctor: {
        type: Boolean,
        description: "Check local Claude/Codex/Grok availability"
      },
      version: {
        type: Boolean,
        alias: "v",
        description: "Print the daemon version"
      }
    },
    help: false
  },
  async (argv) => {
    const flags = argv.flags;
    const commandName = commandNameFromArgv(process.argv[1]);
    const explicitServer = hasExplicitServerArg(process.argv.slice(2));
    const selectedServer = explicitServer ? flags.server : defaultServerForCommand(commandName);
    const serverUrl = selectedServer.replace(/\/+$/, "");
    const tenantId = typeof flags.tenant === "string" && flags.tenant.trim() ? flags.tenant.trim() : undefined;
    const engine = flags.engine as EngineId | undefined;
    assertPreferredEngine(engine);
    if (flags.help) {
      console.log(computerHelpText(selectedServer, commandName));
      return;
    }
    if (flags.version) {
      console.log(versionText(commandName));
      return;
    }
    if (flags.doctor) return runDoctor();
    if (flags.status) return printStatus(commandName);
    if (flags.watch) return watchStatus();
    if (flags.logs) return tailLogs(commandName);
    if (flags.prepareWorktrees) return prepareWorktrees({ execute: flags.yes });
    if (flags.cleanupWorktrees) return cleanupWorktrees({ execute: flags.yes });
    if (flags.restart) return restartService(commandName);
    if (flags.stop) return stopService(commandName);
    if (flags.uninstallService) return uninstallService(commandName);
    if (flags.pair) await doPair(flags.pair, serverUrl, engine, tenantId);
    if (flags.installService) return installService(explicitServer ? serverUrl : undefined, commandName);
    if (flags.pair) {
      const serviceInstalled = isServiceInstalled(commandName);
      if (serviceInstalled) {
        await reloadService(commandName);
        console.log("re-paired; reloaded the background service with the new config");
        return;
      }
      if (!shouldRunAfterPair(serviceInstalled)) return;
    }
    return doRun(explicitServer ? serverUrl : undefined, tenantId);
  }
);

const agentCommand = command({
  name: "agent",
  parameters: ["[agent arguments...]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    }
  },
  help: false,
  strictFlags: false
}, async (argv) => {
  void argv;
  await cli(
    {
      name: `${commandNameFromArgv(process.argv[1])} agent`,
      strictFlags: true,
      commands: [computerCommand],
      help: {
        description: "Agent hosting commands"
      }
    },
    () => {
      const commandName = commandNameFromArgv(process.argv[1]);
      console.log(`Run \`${commandName} agent --help\` for usage.`);
    },
    normalizeComputerArgs(process.argv.slice(3))
  );
});

const skillCheckCommand = command({
  name: "skill-check",
  parameters: ["[skillsDir]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    }
  },
  help: {
  description: "Validate king-ai command references in SKILL.md files"
  }
}, (argv) => {
  const commandName = commandNameFromArgv(process.argv[1]);
  const skillsDir = argv._.skillsDir || process.cwd();
  runSkillCheck(skillsDir, commandName);
});

const projectProfileCommand = command({
  name: "project-profile",
  parameters: ["[path]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    }
  },
  help: {
    description: "Inspect a local repository and render a takeover-ready project profile"
  }
}, (argv) => {
  const projectPath = argv._.path || process.cwd();
  runProjectProfile(projectPath);
});

const usageCommand = command({
  name: "usage",
  parameters: ["[action]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured runtime data JSON"
    },
    out: {
      type: String,
      description: "Output path for `king-ai usage export`"
    },
    results: {
      type: Boolean,
      description: "Print TSV runtime results rows"
    },
    capabilities: {
      type: Boolean,
      description: "Print provider usage capability notes"
    }
  },
  help: {
    description: "Summarize local agent run usage from the running daemon state, list expenses, or export runtime data"
  }
}, async (argv) => {
  const state = await readRunningState();
  const pricingRules = usagePricingFromEnv();
  const runtimeData = buildUsageRuntimeData(state, { budget: tokenBudgetFromEnv(), pricingRules });
  const usageSummary = summarizeAgentUsage(state?.agents ?? [], tokenBudgetFromEnv(), pricingRules);
  if (argv._.action === "export") {
    const out = await writeUsageRuntimeData(argv.flags.out || "king-ai-runtime-data.json", runtimeData);
    console.log(`usage runtime data written: ${out}`);
    return;
  }
  if (argv._.action === "expenses") {
    const rows = listUsageExpenses(usageSummary);
    if (argv.flags.json) {
      console.log(JSON.stringify({ expenses: rows, usage: usageSummary }, null, 2));
    } else {
      console.log(formatUsageExpenses(rows));
    }
    return;
  }
  if (argv.flags.json) {
    console.log(JSON.stringify(runtimeData, null, 2));
    return;
  }
  if (argv.flags.results) {
    console.log(formatRuntimeResultsTable(runtimeData.runtimeResults).trimEnd());
    return;
  }
  const lines = [formatUsageSummary(usageSummary)];
  if (argv.flags.capabilities) lines.push(formatProviderCapabilities(runtimeData.providerCapabilities));
  console.log(lines.join("\n"));
});

function formatTeamScenario(scenario: KingScenarioTemplate): string {
  return [
    `team scenario: ${scenario.id}`,
    `name: ${scenario.name}`,
    `goal: ${scenario.goal}`,
    `roles: ${scenario.team.roles.map((role) => `${role.id}:${role.template}`).join(", ")}`,
    "tasks:",
    ...scenario.tasks.map((task, index) => {
      const review = task.reviewerRole ? ` reviewerRole=${task.reviewerRole}` : "";
      const deps = task.dependsOn?.length ? ` dependsOn=${task.dependsOn.join(",")}` : "";
      return `  ${index + 1}. ownerRole=${task.ownerRole}${review}${deps} ${task.title}`;
    }),
    "acceptance:",
    ...scenario.acceptance.map((entry) => `  - ${entry}`)
  ].join("\n");
}

const teamCommand = command({
  name: "team",
  parameters: ["<scenario>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured team scenario JSON"
    },
    output: {
      type: String,
      description: "Materialize the scenario into this host output directory"
    },
    role: {
      type: String,
      description: "Act as a team role while materializing workflow cards"
    }
  },
  help: {
    description: "Preview or materialize built-in multi-role team workflow scenarios"
  }
}, async (argv) => {
  const scenarioId = argv._.scenario;
  if (scenarioId !== "repo-takeover" && scenarioId !== "bug-investigation" && scenarioId !== "product-design" && scenarioId !== "release-check" && scenarioId !== "research-brief") {
    throw new Error("team scenario must be repo-takeover, bug-investigation, product-design, release-check, or research-brief");
  }
  const scenario = scenarioTemplate(scenarioId);
  if (argv.flags.output) {
    const result = await materializeTeamScenario(scenario, argv.flags.output, argv.flags.role);
    console.log(argv.flags.json ? JSON.stringify(result, null, 2) : formatMaterializedTeamScenario(result));
    return;
  }
  console.log(argv.flags.json ? JSON.stringify(scenario, null, 2) : formatTeamScenario(scenario));
});

export async function materializeTeamScenario(scenario: KingScenarioTemplate, outputDir: string, actorRole?: string): Promise<{ scenario: string; outputDir: string; cards: unknown[] }> {
  const cards: unknown[] = [];
  const initiative = await runHostCommandFromCli({
    command: "initiative-create",
    format: "json",
    actorRole,
    input: {
      outputDir,
      id: `initiative-${scenario.id}`,
      title: scenario.name,
      ownerRole: "planner",
      acceptance: scenario.acceptance,
      detail: scenario.goal
    }
  });
  if (!initiative.ok) throw new Error(initiative.error ?? initiative.text);
  cards.push((initiative.json as { card?: unknown }).card);
  for (const [index, task] of scenario.tasks.entries()) {
    const id = `task-${index + 1}`;
    const result = await runHostCommandFromCli({
      command: "workflow-create",
      format: "json",
      actorRole,
      input: {
        outputDir,
        kind: "task",
        id,
        title: task.title,
        status: "assigned",
        ownerRole: task.ownerRole,
        reviewerRole: task.reviewerRole,
        dependsOn: task.dependsOn,
        acceptance: task.acceptance,
        sourceId: `initiative-${scenario.id}`
      }
    });
    if (!result.ok) throw new Error(result.error ?? result.text);
    cards.push((result.json as { card?: unknown }).card);
  }
  return { scenario: scenario.id, outputDir, cards };
}

export function formatMaterializedTeamScenario(result: { scenario: string; outputDir: string; cards: unknown[] }): string {
  return [
    `team scenario materialized: ${result.scenario}`,
    `output: ${result.outputDir}`,
    `workflow cards: ${result.cards.length}`
  ].join("\n");
}

const hostStatusCommand = command({
  name: "status",
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    }
  },
  help: {
    description: "Print the app-facing local host status snapshot"
  }
}, async (argv) => {
  const state = await readRunningState();
  const snapshot = buildHostStatusSnapshot(state, tokenBudgetFromEnv());
  console.log(argv.flags.json ? JSON.stringify(snapshot, null, 2) : formatHostStatusSnapshot(snapshot));
});

const hostServeCommand = command({
  name: "serve",
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    host: {
      type: String,
      description: "Local bind host: 127.0.0.1, ::1, or localhost",
      default: DEFAULT_HOST_SERVER_HOST
    },
    port: {
      type: String,
      description: "Local bind port",
      default: String(hostServerPortFromEnv())
    },
    executeRuns: {
      type: Boolean,
      description: "Automatically consume pending safe host run requests"
    },
    executeRunsInterval: {
      type: String,
      description: "Auto executor polling interval in milliseconds",
      default: "1000"
    }
  },
  help: {
    description: "Run a read-only localhost HTTP server for host applications"
  }
}, async (argv) => {
  const port = Number.parseInt(argv.flags.port, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
  const executeRunsIntervalMs = Number.parseInt(argv.flags.executeRunsInterval, 10);
  if (!Number.isFinite(executeRunsIntervalMs) || executeRunsIntervalMs < 1) throw new Error("--execute-runs-interval must be a positive integer");
  await serveHostStatus({
    host: argv.flags.host,
    port,
    executeRuns: argv.flags.executeRuns,
    executeRunsIntervalMs
  });
});

const hostCommandsCommand = command({
  name: "commands",
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    }
  },
  help: {
    description: "List controlled host commands available to applications"
  }
}, (argv) => {
  const commands = listHostCommands();
  if (argv.flags.json) {
    console.log(JSON.stringify({ ok: true, commands }, null, 2));
    return;
  }
  console.log(commands.map((entry) => `${entry.name}\t${entry.description}`).join("\n"));
});

function runHostCommandFromCli(request: HostCommandRequest): Promise<HostCommandResult> {
  return runHostCommand(request, { recordTimeline: true });
}

async function printHostCommandResult(request: HostCommandRequest, json: boolean): Promise<void> {
  const result = await runHostCommandFromCli({ ...request, format: json ? "json" : "text" });
  console.log(json ? JSON.stringify(result.json ?? result, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
}

const roleFlag = {
  role: {
    type: String,
    description: "Act as a team role; applies opt-in governance/audit policy (or set KING_AI_TEAM_ROLE)"
  }
};

function parseJsonInput(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (err) {
    throw new Error(`--input must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const hostRunCommand = command({
  name: "run",
  parameters: ["<command>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    input: {
      type: String,
      description: "JSON object input for the host command"
    },
    role: {
      type: String,
      description: "Act as a team role; applies opt-in governance/audit policy (or set KING_AI_TEAM_ROLE)"
    }
  },
  help: {
    description: "Run an allowlisted local host command"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: argv._.command,
    format: argv.flags.json ? "json" : "text",
    input: parseJsonInput(argv.flags.input),
    actorRole: argv.flags.role
  });
  if (argv.flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.text);
  }
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostPlanRunCommand = command({
  name: "plan-run",
  parameters: ["<goal>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    project: {
      type: String,
      description: "Existing local project directory"
    },
    engine: {
      type: String,
      description: "Preferred local engine: claude, codex, or grok"
    },
    model: {
      type: String,
      description: "Model override"
    },
    fastModel: {
      type: String,
      description: "Fast model override"
    },
    loops: {
      type: String,
      description: "Maximum polling loops",
      default: "100"
    },
    infinite: {
      type: Boolean,
      description: "Create an infinite loop plan"
    },
    output: {
      type: String,
      description: "Output directory",
      default: "deliverables"
    },
    roleProfile: {
      type: String,
      description: "Default local role profile: small, engineering, product, or full"
    }
  },
  help: {
    description: "Preview a reproducible host app run request"
  }
}, async (argv) => {
  const engine = argv.flags.engine as EngineId | undefined;
  assertPreferredEngine(engine);
  const loops = Number.parseInt(argv.flags.loops, 10);
  if (!Number.isFinite(loops) || loops < 1) throw new Error("--loops must be a positive integer");
  const result = await runHostCommandFromCli({
    command: "plan-run",
    format: argv.flags.json ? "json" : "text",
    input: {
      goal: argv._.goal,
      mode: "run",
      projectDir: argv.flags.project,
      roleProfile: argv.flags.roleProfile,
      options: {
        engine,
        model: argv.flags.model,
        fastModel: argv.flags.fastModel,
        loops: argv.flags.infinite ? Infinity : loops,
        loopMode: argv.flags.infinite ? "infinite" : "bounded",
        outputDir: argv.flags.output
      }
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

const hostPreflightCommand = command({
  name: "preflight",
  parameters: ["<goal>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    project: {
      type: String,
      description: "Existing local project directory"
    },
    engine: {
      type: String,
      description: "Preferred local engine: claude, codex, or grok"
    },
    takeover: {
      type: Boolean,
      description: "Preflight a takeover-style run"
    },
    roleProfile: {
      type: String,
      description: "Default local role profile: small, engineering, product, or full"
    }
  },
  help: {
    description: "Check whether a host app run request is ready to launch"
  }
}, async (argv) => {
  const engine = argv.flags.engine as EngineId | undefined;
  assertPreferredEngine(engine);
  const result = await runHostCommandFromCli({
    command: "preflight",
    format: argv.flags.json ? "json" : "text",
    input: {
      goal: argv._.goal,
      mode: argv.flags.takeover ? "takeover" : "run",
      projectDir: argv.flags.project,
      roleProfile: argv.flags.roleProfile,
      options: { engine }
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostPrepareRunLayoutCommand = command({
  name: "prepare-run-layout",
  parameters: ["<goal>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    project: {
      type: String,
      description: "Existing local project directory"
    },
    engine: {
      type: String,
      description: "Preferred local engine: claude, codex, or grok"
    },
    output: {
      type: String,
      description: "Output directory",
      default: "deliverables"
    },
    runId: {
      type: String,
      description: "Stable run id"
    },
    force: {
      type: Boolean,
      description: "Replace an existing prepared layout with the same run id"
    },
    roleProfile: {
      type: String,
      description: "Default local role profile: small, engineering, product, or full"
    }
  },
  help: {
    description: "Materialize a local host run layout after explicit confirmation"
  }
}, async (argv) => {
  const engine = argv.flags.engine as EngineId | undefined;
  assertPreferredEngine(engine);
  const result = await runHostCommandFromCli({
    command: "prepare-run-layout",
    format: argv.flags.json ? "json" : "text",
    input: {
      goal: argv._.goal,
      runId: argv.flags.runId,
      projectDir: argv.flags.project,
      roleProfile: argv.flags.roleProfile,
      force: argv.flags.force,
      confirmed: true,
      options: {
        engine,
        outputDir: argv.flags.output
      }
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostSubmitRunCommand = command({
  name: "submit-run",
  parameters: ["<goal>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    project: {
      type: String,
      description: "Existing local project directory"
    },
    engine: {
      type: String,
      description: "Preferred local engine: claude, codex, or grok"
    },
    model: {
      type: String,
      description: "Model override"
    },
    requestId: {
      type: String,
      description: "Stable app-side request id"
    },
    takeover: {
      type: Boolean,
      description: "Submit a takeover-style run request"
    },
    roleProfile: {
      type: String,
      description: "Default local role profile: small, engineering, product, or full"
    },
    ...roleFlag
  },
  help: {
    description: "Persist a pending host app run request"
  }
}, async (argv) => {
  const engine = argv.flags.engine as EngineId | undefined;
  assertPreferredEngine(engine);
  const result = await runHostCommandFromCli({
    command: "submit-run",
    format: argv.flags.json ? "json" : "text",
    actorRole: argv.flags.role,
    input: {
      goal: argv._.goal,
      requestId: argv.flags.requestId,
      mode: argv.flags.takeover ? "takeover" : "run",
      projectDir: argv.flags.project,
      roleProfile: argv.flags.roleProfile,
      options: {
        engine,
        model: argv.flags.model
      }
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostRunRequestsCommand = command({
  name: "run-requests",
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    limit: {
      type: String,
      description: "Maximum requests to print",
      default: "20"
    },
    status: {
      type: String,
      description: "Filter by status: pending, running, completed, failed, or cancelled"
    }
  },
  help: {
    description: "List pending host app run requests"
  }
}, async (argv) => {
  const limit = Number.parseInt(argv.flags.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const result = await runHostCommandFromCli({
    command: "run-requests",
    format: argv.flags.json ? "json" : "text",
    input: { limit, status: argv.flags.status }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

const hostRunRequestCommand = command({
  name: "run-request",
  parameters: ["<id>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    }
  },
  help: {
    description: "Show one host app run request"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "run-request",
    format: argv.flags.json ? "json" : "text",
    input: { id: argv._.id }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostUpdateRunCommand = command({
  name: "update-run",
  parameters: ["<id>", "<status>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    detail: {
      type: String,
      description: "Short status detail"
    },
    ...roleFlag
  },
  help: {
    description: "Append a lifecycle status update for a host app run request"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "update-run",
    format: argv.flags.json ? "json" : "text",
    actorRole: argv.flags.role,
    input: {
      id: argv._.id,
      status: argv._.status,
      detail: argv.flags.detail
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostCancelRunCommand = command({
  name: "cancel-run",
  parameters: ["<id>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    detail: {
      type: String,
      description: "Short cancellation detail"
    },
    ...roleFlag
  },
  help: {
    description: "Cancel a queued or active host app run request"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "cancel-run",
    format: argv.flags.json ? "json" : "text",
    actorRole: argv.flags.role,
    input: {
      id: argv._.id,
      detail: argv.flags.detail
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostExecuteRunCommand = command({
  name: "execute-run",
  parameters: ["[id]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    ...roleFlag
  },
  help: {
    description: "Consume one pending host app run request with a safe local executor"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "execute-run",
    format: argv.flags.json ? "json" : "text",
    actorRole: argv.flags.role,
    input: argv._.id ? { id: argv._.id } : {}
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostWatchRunCommand = command({
  name: "watch-run",
  parameters: ["[id]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    file: {
      type: String,
      description: "Path to loop-events.ndjson"
    },
    output: {
      type: String,
      description: "Run output directory"
    },
    tail: {
      type: String,
      description: "Maximum events to print",
      default: "20"
    },
    type: {
      type: String,
      description: "Filter by loop event type"
    },
    agent: {
      type: String,
      description: "Filter by agent id or name"
    },
    classification: {
      type: String,
      description: "Filter by loop classification"
    }
  },
  help: {
    description: "Read King AI loop events from a host run output"
  }
}, async (argv) => {
  const tail = Number.parseInt(argv.flags.tail, 10);
  if (!Number.isFinite(tail) || tail < 1) throw new Error("--tail must be a positive integer");
  const result = await runHostCommandFromCli({
    command: "watch-run",
    format: argv.flags.json ? "json" : "text",
    input: {
      id: argv._.id,
      file: argv.flags.file,
      outputDir: argv.flags.output,
      tail,
      type: argv.flags.type,
      agent: argv.flags.agent,
      classification: argv.flags.classification
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

const hostEmitRunEventCommand = command({
  name: "emit-run-event",
  parameters: ["<id>", "<type>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    file: {
      type: String,
      description: "Path to loop-events.ndjson"
    },
    output: {
      type: String,
      description: "Run output directory"
    },
    agent: {
      type: String,
      description: "Agent id or app source"
    },
    loop: {
      type: String,
      description: "Loop number"
    },
    classification: {
      type: String,
      description: "Loop classification"
    },
    detail: {
      type: String,
      description: "Short event detail"
    },
    message: {
      type: String,
      description: "Human-readable event message"
    },
    payload: {
      type: String,
      description: "Optional JSON payload"
    }
  },
  help: {
    description: "Append an app-facing event to a host run output"
  }
}, async (argv) => {
  const loop = argv.flags.loop === undefined ? undefined : Number(argv.flags.loop);
  if (loop !== undefined && (!Number.isFinite(loop) || loop < 0)) throw new Error("--loop must be a non-negative number");
  const payload = argv.flags.payload === undefined ? undefined : JSON.parse(argv.flags.payload);
  const result = await runHostCommandFromCli({
    command: "emit-run-event",
    format: argv.flags.json ? "json" : "text",
    input: {
      id: argv._.id,
      file: argv.flags.file,
      outputDir: argv.flags.output,
      type: argv._.type,
      agent: argv.flags.agent,
      loop,
      classification: argv.flags.classification,
      detail: argv.flags.detail,
      message: argv.flags.message,
      payload
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostRunResultsCommand = command({
  name: "run-results",
  parameters: ["[id]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    file: {
      type: String,
      description: "Path to loop-events.ndjson"
    },
    results: {
      type: String,
      description: "Path to results.tsv"
    },
    output: {
      type: String,
      description: "Run output directory"
    }
  },
  help: {
    description: "Read King AI results.tsv rows from a host run output"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "run-results",
    format: argv.flags.json ? "json" : "text",
    input: {
      id: argv._.id,
      file: argv.flags.file,
      resultsFile: argv.flags.results,
      outputDir: argv.flags.output
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

const hostRunHeartbeatCommand = command({
  name: "run-heartbeat",
  parameters: ["[id]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    file: {
      type: String,
      description: "Path to .king-ai/heartbeat.json"
    },
    output: {
      type: String,
      description: "Run output directory"
    }
  },
  help: {
    description: "Read a host run heartbeat file"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "run-heartbeat",
    format: argv.flags.json ? "json" : "text",
    input: {
      id: argv._.id,
      file: argv.flags.file,
      outputDir: argv.flags.output
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

const hostRunMetaCommand = command({
  name: "run-meta",
  parameters: ["[id]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    file: {
      type: String,
      description: "Path to meta.json"
    },
    output: {
      type: String,
      description: "Run output directory"
    }
  },
  help: {
    description: "Read a host run meta.json file"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "run-meta",
    format: argv.flags.json ? "json" : "text",
    input: {
      id: argv._.id,
      file: argv.flags.file,
      outputDir: argv.flags.output
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

function hostExportInputFromFlags(flags: { workspace?: string; repo?: string; output?: string; runId?: string; noWorkspace?: boolean; noRepoPatch?: boolean; capsuleId?: string; capsulesFile?: string }) {
  return {
    workspaceRoot: flags.workspace,
    repoRoot: flags.repo,
    outputDir: flags.output,
    runId: flags.runId,
    includeWorkspace: flags.noWorkspace ? false : undefined,
    includeRepoPatch: flags.noRepoPatch ? false : undefined,
    capsuleId: flags.capsuleId,
    capsulesFile: flags.capsulesFile
  };
}

const hostPlanExportCommand = command({
  name: "plan-export",
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    workspace: {
      type: String,
      description: "Agent workspace directory to export"
    },
    repo: {
      type: String,
      description: "Git repository root to export status and patches from"
    },
    output: {
      type: String,
      description: "Output directory",
      default: "deliverables"
    },
    runId: {
      type: String,
      description: "Stable export id"
    },
    noWorkspace: {
      type: Boolean,
      description: "Do not export workspace files"
    },
    noRepoPatch: {
      type: Boolean,
      description: "Do not export repository status or patches"
    },
    capsuleId: {
      type: String,
      description: "Capsule id to include from capsules.jsonl"
    },
    capsulesFile: {
      type: String,
      description: "Explicit capsules.jsonl path"
    }
  },
  help: {
    description: "Preview host artifact and repo patch export outputs"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "plan-export",
    format: argv.flags.json ? "json" : "text",
    input: hostExportInputFromFlags(argv.flags)
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

const hostExportCommand = command({
  name: "export",
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    workspace: {
      type: String,
      description: "Agent workspace directory to export"
    },
    repo: {
      type: String,
      description: "Git repository root to export status and patches from"
    },
    output: {
      type: String,
      description: "Output directory",
      default: "deliverables"
    },
    runId: {
      type: String,
      description: "Stable export id"
    },
    noWorkspace: {
      type: Boolean,
      description: "Do not export workspace files"
    },
    noRepoPatch: {
      type: Boolean,
      description: "Do not export repository status or patches"
    },
    capsuleId: {
      type: String,
      description: "Capsule id to include from capsules.jsonl"
    },
    capsulesFile: {
      type: String,
      description: "Explicit capsules.jsonl path"
    },
    ...roleFlag
  },
  help: {
    description: "Export host artifacts and repo patches to an output directory"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "export",
    format: argv.flags.json ? "json" : "text",
    actorRole: argv.flags.role,
    input: { ...hostExportInputFromFlags(argv.flags), confirmed: true }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

const hostPolicyCommand = command({
  name: "policy",
  parameters: ["<command>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    confirm: {
      type: Boolean,
      description: "Include explicit operator confirmation"
    }
  },
  help: {
    description: "Check host command safety policy"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "policy",
    format: argv.flags.json ? "json" : "text",
    input: {
      command: argv._.command,
      confirmed: argv.flags.confirm
    }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const hostTimelineCommand = command({
  name: "timeline",
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    limit: {
      type: String,
      description: "Maximum events to print",
      default: "20"
    },
    ...roleFlag
  },
  help: {
    description: "Show recent host command audit events"
  }
}, async (argv) => {
  const limit = Number.parseInt(argv.flags.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const result = await runHostCommandFromCli({
    command: "timeline",
    format: argv.flags.json ? "json" : "text",
    actorRole: argv.flags.role,
    input: { limit }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
});

const remoteCommonFlags = {
  json: {
    type: Boolean,
    description: "Print structured JSON for host applications"
  },
  device: {
    type: String,
    description: "Remote test device id or host"
  },
  timeout: {
    type: String,
    description: "Remote command timeout in milliseconds"
  },
  maxOutput: {
    type: String,
    description: "Maximum output bytes to keep"
  }
};

function remoteInput(flags: { device?: string; timeout?: string; maxOutput?: string }): Record<string, unknown> {
  return {
    ...(flags.device ? { device: flags.device } : {}),
    ...(flags.timeout ? { timeoutMs: flags.timeout } : {}),
    ...(flags.maxOutput ? { maxOutputBytes: flags.maxOutput } : {})
  };
}

const hostRemoteListCommand = command({
  name: "remote-list",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    json: { type: Boolean, description: "Print structured JSON for host applications" }
  },
  help: { description: "List configured remote test devices" }
}, async (argv) => {
  await printHostCommandResult({ command: "remote-list" }, Boolean(argv.flags.json));
});

const hostRemoteProbeCommand = command({
  name: "remote-probe",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    ...remoteCommonFlags
  },
  help: { description: "Probe SSH connectivity for a remote test device" }
}, async (argv) => {
  await printHostCommandResult({ command: "remote-probe", input: remoteInput(argv.flags) }, Boolean(argv.flags.json));
});

const hostRemoteProfileCommand = command({
  name: "remote-profile",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    ...remoteCommonFlags
  },
  help: { description: "Collect a remote test device profile" }
}, async (argv) => {
  await printHostCommandResult({ command: "remote-profile", input: remoteInput(argv.flags) }, Boolean(argv.flags.json));
});

const hostRemoteRunCommand = command({
  name: "remote-run",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    ...remoteCommonFlags,
    cmd: { type: String, description: "Shell command to run on the remote test device" }
  },
  help: { description: "Run a command on a remote test device" }
}, async (argv) => {
  if (!argv.flags.cmd) throw new Error("--cmd is required");
  await printHostCommandResult({ command: "remote-run", input: { ...remoteInput(argv.flags), cmd: argv.flags.cmd } }, Boolean(argv.flags.json));
});

const hostRemoteLogsCommand = command({
  name: "remote-logs",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    ...remoteCommonFlags,
    app: { type: String, description: "Configured app name" },
    path: { type: String, description: "Log file path" },
    tail: { type: String, description: "Number of lines to tail", default: "200" }
  },
  help: { description: "Tail logs on a remote test device" }
}, async (argv) => {
  await printHostCommandResult({ command: "remote-logs", input: { ...remoteInput(argv.flags), app: argv.flags.app, path: argv.flags.path, tail: argv.flags.tail } }, Boolean(argv.flags.json));
});

const hostRemoteFindLogsCommand = command({
  name: "remote-find-logs",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    ...remoteCommonFlags,
    app: { type: String, description: "Configured app name" },
    path: { type: String, description: "Log file or directory path" },
    pattern: { type: String, description: "grep -E pattern to search" },
    since: { type: String, description: "Human label for the intended time window" },
    tail: { type: String, description: "Number of matches to keep", default: "200" }
  },
  help: { description: "Search logs on a remote test device" }
}, async (argv) => {
  if (!argv.flags.pattern) throw new Error("--pattern is required");
  await printHostCommandResult({ command: "remote-find-logs", input: { ...remoteInput(argv.flags), app: argv.flags.app, path: argv.flags.path, pattern: argv.flags.pattern, since: argv.flags.since, tail: argv.flags.tail } }, Boolean(argv.flags.json));
});

const hostRemotePgCommand = command({
  name: "remote-pg",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    ...remoteCommonFlags,
    db: { type: String, description: "Configured database name", default: "default" },
    sql: { type: String, description: "SQL to execute through the configured psql command" }
  },
  help: { description: "Run PostgreSQL SQL on a remote test device" }
}, async (argv) => {
  if (!argv.flags.sql) throw new Error("--sql is required");
  await printHostCommandResult({ command: "remote-pg", input: { ...remoteInput(argv.flags), db: argv.flags.db, sql: argv.flags.sql } }, Boolean(argv.flags.json));
});

const hostRemoteRedisCommand = command({
  name: "remote-redis",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    ...remoteCommonFlags,
    name: { type: String, description: "Configured Redis name", default: "default" },
    cmd: { type: String, description: "Redis command arguments" }
  },
  help: { description: "Run Redis command on a remote test device" }
}, async (argv) => {
  if (!argv.flags.cmd) throw new Error("--cmd is required");
  await printHostCommandResult({ command: "remote-redis", input: { ...remoteInput(argv.flags), name: argv.flags.name, cmd: argv.flags.cmd } }, Boolean(argv.flags.json));
});

const hostWorkflowCommand = command({
  name: "workflow",
  parameters: ["<action>"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    },
    json: {
      type: Boolean,
      description: "Print structured JSON for host applications"
    },
    input: {
      type: String,
      description: "JSON input for workflow-create/list/update"
    },
    ...roleFlag
  },
  help: {
    description: "Create, list, or update first-class host workflow objects"
  }
}, async (argv) => {
  const action = argv._.action;
  const commandName = action === "create" || action === "list" || action === "update"
    ? `workflow-${action}`
    : action === "initiative" || action === "handoff" || action === "review" || action === "decision" || action === "artifact"
      ? `${action}-create`
      : undefined;
  if (!commandName) throw new Error("workflow action must be create, list, update, initiative, handoff, review, decision, or artifact");
  const result = await runHostCommandFromCli({
    command: commandName,
    format: argv.flags.json ? "json" : "text",
    actorRole: argv.flags.role,
    input: parseJsonInput(argv.flags.input) ?? {}
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
  if (!result.ok || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
});

const tradeAlertRunCommand = command({
  name: "run",
  parameters: ["<ruleId>"],
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    once: { type: Boolean, description: "Run one check cycle then exit" },
    pushTg: { type: Boolean, description: "Push warning/critical alerts to Telegram" },
    dryRun: { type: Boolean, description: "Print only; do not write logs or push" },
    poll: { type: Number, description: "Poll interval seconds (default from trade_config.json)" }
  },
  help: { description: "Run a single trade alert rule" }
}, async (argv) => {
  const ruleId = argv._.ruleId;
  if (!ruleId) throw new Error("rule id required, e.g. a, b, c");
  const rule = await createRuleAsync(ruleId);
  if (!rule) throw new Error(`Unknown rule: ${ruleId}. Available: ${listRuleIds().join(", ")}`);
  await runRuleLoop(rule, {
    pollSeconds: argv.flags.poll,
    pushTg: argv.flags.pushTg,
    dryRun: argv.flags.dryRun,
    runOnce: argv.flags.once,
    onStatus: (line) => process.stdout.write(`${line}\n`)
  });
});

const tradeAlertListCommand = command({
  name: "list",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" }
  },
  help: { description: "List registered trade alert rules" }
}, () => {
  console.log(listRuleIds().join("\n"));
});

const tradeAlertCommand = command({
  name: "alert",
  parameters: ["[alert arguments...]"],
  flags: { help: { type: Boolean, alias: "h", description: "Show help" } },
  help: false,
  strictFlags: false
}, async () => {
  await cli(
    {
      name: `${commandNameFromArgv(process.argv[1])} trade alert`,
      strictFlags: true,
      commands: [tradeAlertRunCommand, tradeAlertListCommand],
      help: { description: "Trade alert rules" }
    },
    () => console.log(`Run \`${commandNameFromArgv(process.argv[1])} trade alert --help\` for usage.`),
    process.argv.slice(4)
  );
});

const tradeBriefCommand = command({
  name: "brief",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    pushTg: { type: Boolean, description: "Push brief to Telegram" },
    dryRun: { type: Boolean, description: "Print only" },
    sections: { type: String, description: "Comma-separated sections: market,stocks,treasury,telegram,twitter,leaderboard,pumpfun" },
    hours: { type: Number, description: "Lookback hours for social sections" }
  },
  help: { description: "Daily morning brief" }
}, async (argv) => {
  const sections = argv.flags.sections
    ? argv.flags.sections.split(",").map((s) => s.trim()).filter(Boolean) as BriefSection[]
    : undefined;
  await runMorningBrief({
    sections,
    hours: argv.flags.hours,
    pushTg: argv.flags.pushTg,
    dryRun: argv.flags.dryRun
  });
});

const tradeDaemonCommand = command({
  name: "daemon",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    pushTg: { type: Boolean, description: "Push alerts and brief to Telegram" },
    dryRun: { type: Boolean, description: "Dry run mode" }
  },
  help: { description: "Run trade supervisor: unified rule poll + cron brief" }
}, async (argv) => {
  await runTradeDaemon({ pushTg: argv.flags.pushTg, dryRun: argv.flags.dryRun });
});

const tradeInstallServiceCommand = command({
  name: "install-service",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    pushTg: { type: Boolean, description: "Enable Telegram push in the background daemon" }
  },
  help: { description: "Install LaunchAgent/systemd service for king-ai trade daemon" }
}, async (argv) => {
  await installTradeService({ pushTg: argv.flags.pushTg });
});

const tradeUninstallServiceCommand = command({
  name: "uninstall-service",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" }
  },
  help: { description: "Remove the king-ai trade background service" }
}, async () => {
  await uninstallTradeService();
  await killRunningTradeDaemons();
});

const tradeRestartServiceCommand = command({
  name: "restart-service",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" }
  },
  help: { description: "Restart the king-ai trade background service" }
}, async () => {
  await restartTradeService();
});

const tradeStatusCommand = command({
  name: "status",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" }
  },
  help: { description: "Show trade daemon service status" }
}, async () => {
  await printTradeServiceStatus();
});

const tradeLogsCommand = command({
  name: "logs",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" }
  },
  help: { description: "Tail trade daemon logs" }
}, async () => {
  await tailTradeLogs();
});

const tradeCollectCommand = command({
  name: "collect",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" }
  },
  help: { description: "Run Twitter collector once (cache + ticker mentions)" }
}, async () => {
  await runTwitterCollector();
});

const tradeVerifyTgCommand = command({
  name: "verify-tg",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    dryRun: { type: Boolean, description: "Print only; do not push to Telegram" },
    noCollect: { type: Boolean, description: "Skip twitter-collector before tm check" }
  },
  help: { description: "Run each alert/brief source once and push one Telegram message per source" }
}, async (argv) => {
  await runVerifySignalsPush({ collect: !argv.flags.noCollect, dryRun: argv.flags.dryRun });
});

const tradeVerifyCelebrityCommand = command({
  name: "verify-celebrity",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    dryRun: { type: Boolean, description: "Browser health check only; do not push Telegram" }
  },
  help: { description: "Check celebrity Twitter/X search pages for articles, no-results, login, or challenge states" }
}, async (argv) => {
  await runVerifyCelebrity({ dryRun: argv.flags.dryRun });
});

const tradeWatchdogCommand = command({
  name: "watchdog",
  flags: {
    help: { type: Boolean, alias: "h", description: "Show help" },
    kill: { type: Boolean, description: "Kill orphan processes" },
    pushTg: { type: Boolean, description: "Push alerts to Telegram" },
    health: { type: Boolean, description: "Health check only" }
  },
  help: { description: "Process watchdog: orphans, load, service health" }
}, async (argv) => {
  await runProcessWatchdog({
    kill: argv.flags.kill,
    pushTg: argv.flags.pushTg,
    log: true,
    healthOnly: argv.flags.health
  });
});

const tradeCommand = command({
  name: "trade",
  parameters: ["[trade arguments...]"],
  flags: { help: { type: Boolean, alias: "h", description: "Show help" } },
  help: false,
  strictFlags: false
}, async () => {
  await cli(
    {
      name: `${commandNameFromArgv(process.argv[1])} trade`,
      strictFlags: true,
      commands: [
        tradeDaemonCommand,
        tradeInstallServiceCommand,
        tradeUninstallServiceCommand,
        tradeRestartServiceCommand,
        tradeStatusCommand,
        tradeLogsCommand,
        tradeCollectCommand,
        tradeVerifyTgCommand,
        tradeVerifyCelebrityCommand,
        tradeWatchdogCommand,
        tradeAlertCommand,
        tradeBriefCommand
      ],
      help: { description: "Crypto trade intelligence (alerts, brief, verify-tg)" }
    },
    () => console.log(`Run \`${commandNameFromArgv(process.argv[1])} trade --help\` for usage.`),
    process.argv.slice(3)
  );
});

const hostCommand = command({
  name: "host",
  parameters: ["[host arguments...]"],
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    }
  },
  help: false,
  strictFlags: false
}, async () => {
  await cli(
    {
      name: `${commandNameFromArgv(process.argv[1])} host`,
      strictFlags: true,
      commands: [hostStatusCommand, hostServeCommand, hostCommandsCommand, hostRunCommand, hostPlanRunCommand, hostPreflightCommand, hostPrepareRunLayoutCommand, hostSubmitRunCommand, hostRunRequestsCommand, hostRunRequestCommand, hostUpdateRunCommand, hostCancelRunCommand, hostExecuteRunCommand, hostEmitRunEventCommand, hostWatchRunCommand, hostRunResultsCommand, hostRunHeartbeatCommand, hostRunMetaCommand, hostPlanExportCommand, hostExportCommand, hostTimelineCommand, hostPolicyCommand, hostRemoteListCommand, hostRemoteProbeCommand, hostRemoteProfileCommand, hostRemoteRunCommand, hostRemoteLogsCommand, hostRemoteFindLogsCommand, hostRemotePgCommand, hostRemoteRedisCommand, hostWorkflowCommand],
      help: {
        description: "Host application integration commands"
      }
    },
    () => {
      const commandName = commandNameFromArgv(process.argv[1]);
      console.log(`Run \`${commandName} host --help\` for usage.`);
    },
    process.argv.slice(3)
  );
});

async function main(): Promise<void> {
  await cli(
    {
      name: commandNameFromArgv(process.argv[1]),
      version: CURRENT_VERSION,
      strictFlags: true,
      commands: [agentCommand, skillCheckCommand, projectProfileCommand, usageCommand, teamCommand, tradeCommand, hostCommand],
      help: {
        description: "Local BYOA agent daemon",
        examples: [
          `${commandNameFromArgv(process.argv[1])} agent computer --pair abc123 --server https://runtime.example`,
          `${commandNameFromArgv(process.argv[1])} agent computer --doctor`,
          `${commandNameFromArgv(process.argv[1])} usage`,
          `${commandNameFromArgv(process.argv[1])} team repo-takeover --json`,
          `${commandNameFromArgv(process.argv[1])} host status --json`,
          `${commandNameFromArgv(process.argv[1])} host run status --json`,
          `${commandNameFromArgv(process.argv[1])} host plan-run "review this repo" --project . --json`,
          `${commandNameFromArgv(process.argv[1])} host preflight "review this repo" --project .`,
          `${commandNameFromArgv(process.argv[1])} host prepare-run-layout "review this repo" --project . --run-id demo`,
          `${commandNameFromArgv(process.argv[1])} host submit-run "review this repo" --project . --json`,
          `${commandNameFromArgv(process.argv[1])} host run-requests --json`,
          `${commandNameFromArgv(process.argv[1])} host emit-run-event demo app.note --message "reviewed"`,
          `${commandNameFromArgv(process.argv[1])} host watch-run demo --tail 20`,
          `${commandNameFromArgv(process.argv[1])} host run-results demo --json`,
          `${commandNameFromArgv(process.argv[1])} host run-heartbeat demo --json`,
          `${commandNameFromArgv(process.argv[1])} host run-meta demo --json`,
          `${commandNameFromArgv(process.argv[1])} host execute-run`,
          `${commandNameFromArgv(process.argv[1])} host plan-export --workspace ./agent-workspace --repo . --json`,
          `${commandNameFromArgv(process.argv[1])} host timeline --json`,
          `${commandNameFromArgv(process.argv[1])} host policy export --json`,
          `${commandNameFromArgv(process.argv[1])} host serve --port 8799`,
          `${commandNameFromArgv(process.argv[1])} host serve --execute-runs`,
          `${commandNameFromArgv(process.argv[1])} skill-check ./skills`,
          `${commandNameFromArgv(process.argv[1])} project-profile .`,
          `${commandNameFromArgv(process.argv[1])} trade install-service --push-tg`,
          `${commandNameFromArgv(process.argv[1])} trade collect`,
          `${commandNameFromArgv(process.argv[1])} trade daemon --push-tg`,
          `${commandNameFromArgv(process.argv[1])} trade alert run q --once`,
          `${commandNameFromArgv(process.argv[1])} trade brief --push-tg`,
          `${commandNameFromArgv(process.argv[1])} trade verify-tg --dry-run`,
          `${commandNameFromArgv(process.argv[1])} trade verify-celebrity --dry-run`
        ]
      }
    },
    () => {
      const commandName = commandNameFromArgv(process.argv[1]);
      console.log(`Run \`${commandName} --help\` for usage.`);
    }
  );
}

function isDirectCliInvocation(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
}

if (isDirectCliInvocation(process.argv[1], import.meta.url)) {
  void main().catch((err) => {
    process.stderr.write(`${commandNameFromArgv(process.argv[1])}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(70);
  });
}
