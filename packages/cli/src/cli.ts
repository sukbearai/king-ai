#!/usr/bin/env node
import { cli, command } from "cleye";
import { pathToFileURL } from "node:url";
import { CURRENT_VERSION, DEFAULT_SERVER } from "./paths.js";
import { doPair, doRun, runDoctor } from "./daemon.js";
import { cleanupWorktrees, installService, isServiceInstalled, prepareWorktrees, printStatus, readRunningState, reloadService, restartService, stopService, tailLogs, uninstallService, watchStatus } from "./service.js";
import type { CommandName } from "./service.js";
import { runSkillCheck } from "./skill-check.js";
import { runProjectProfile } from "./project-profile.js";
import { formatUsageSummary, summarizeAgentUsage, tokenBudgetFromEnv } from "./usage.js";
import { buildHostStatusSnapshot, formatHostStatusSnapshot } from "./host-api.js";
import { listHostCommands, runHostCommand } from "./host-control.js";
import type { HostCommandRequest, HostCommandResult } from "./host-control.js";
import { DEFAULT_HOST_SERVER_HOST, hostServerPortFromEnv, serveHostStatus } from "./host-server.js";
import type { EngineId } from "./types.js";

export function commandNameFromArgv(_argv0?: string): CommandName {
  return "king";
}

export function versionText(_commandName: string, version = CURRENT_VERSION): string {
  return `king ${version}`;
}

export function defaultServerForCommand(_commandName: string): string {
  return DEFAULT_SERVER;
}

export function hasExplicitServerArg(args: string[]): boolean {
  return args.some((arg) => arg === "--server" || arg.startsWith("--server="));
}

export function computerHelpText(defaultServer = DEFAULT_SERVER, commandName = "king"): string {
  return [
    `${commandName} agent computer - run local BYOA agents on THIS machine`,
    "",
    "The daemon talks to a runtime server over HTTP and drives a local agent",
    "engine (Claude Code or Codex). Pair once, then it can run in the background.",
    "",
    "Usage:",
    `  ${commandName} agent computer --pair <code> [--server <url>] [--engine <id>]`,
    `  ${commandName} agent computer [--server <url>]`,
    "",
    "Setup:",
    "  --pair <code>        pair this machine with the runtime",
    `  --server <url>       runtime server URL (default: ${defaultServer})`,
    "  --engine <id>        force an engine: claude | codex",
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
      engine: {
        type: String,
        description: "Preferred local engine: claude or codex"
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
        description: "Check local Claude/Codex availability"
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
    const engine = flags.engine as EngineId | undefined;
    if (engine && engine !== "claude" && engine !== "codex") throw new Error("--engine must be claude or codex");
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
    if (flags.pair) await doPair(flags.pair, serverUrl, engine);
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
    return doRun(explicitServer ? serverUrl : undefined);
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
  description: "Validate king command references in SKILL.md files"
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
  flags: {
    help: {
      type: Boolean,
      alias: "h",
      description: "Show help"
    }
  },
  help: {
    description: "Summarize local agent run usage from the running daemon state"
  }
}, async () => {
  const state = await readRunningState();
  console.log(formatUsageSummary(summarizeAgentUsage(state?.agents ?? [], tokenBudgetFromEnv())));
});

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
    }
  },
  help: {
    description: "Run an allowlisted local host command"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: argv._.command,
    format: argv.flags.json ? "json" : "text"
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
      description: "Preferred local engine: claude or codex"
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
    }
  },
  help: {
    description: "Preview a reproducible host app run request"
  }
}, async (argv) => {
  const engine = argv.flags.engine as EngineId | undefined;
  if (engine && engine !== "claude" && engine !== "codex") throw new Error("--engine must be claude or codex");
  const loops = Number.parseInt(argv.flags.loops, 10);
  if (!Number.isFinite(loops) || loops < 1) throw new Error("--loops must be a positive integer");
  const result = await runHostCommandFromCli({
    command: "plan-run",
    format: argv.flags.json ? "json" : "text",
    input: {
      goal: argv._.goal,
      mode: "run",
      projectDir: argv.flags.project,
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
      description: "Preferred local engine: claude or codex"
    },
    takeover: {
      type: Boolean,
      description: "Preflight a takeover-style run"
    }
  },
  help: {
    description: "Check whether a host app run request is ready to launch"
  }
}, async (argv) => {
  const engine = argv.flags.engine as EngineId | undefined;
  if (engine && engine !== "claude" && engine !== "codex") throw new Error("--engine must be claude or codex");
  const result = await runHostCommandFromCli({
    command: "preflight",
    format: argv.flags.json ? "json" : "text",
    input: {
      goal: argv._.goal,
      mode: argv.flags.takeover ? "takeover" : "run",
      projectDir: argv.flags.project,
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
      description: "Preferred local engine: claude or codex"
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
    }
  },
  help: {
    description: "Materialize a local host run layout after explicit confirmation"
  }
}, async (argv) => {
  const engine = argv.flags.engine as EngineId | undefined;
  if (engine && engine !== "claude" && engine !== "codex") throw new Error("--engine must be claude or codex");
  const result = await runHostCommandFromCli({
    command: "prepare-run-layout",
    format: argv.flags.json ? "json" : "text",
    input: {
      goal: argv._.goal,
      runId: argv.flags.runId,
      projectDir: argv.flags.project,
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
      description: "Preferred local engine: claude or codex"
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
    }
  },
  help: {
    description: "Persist a pending host app run request"
  }
}, async (argv) => {
  const engine = argv.flags.engine as EngineId | undefined;
  if (engine && engine !== "claude" && engine !== "codex") throw new Error("--engine must be claude or codex");
  const result = await runHostCommandFromCli({
    command: "submit-run",
    format: argv.flags.json ? "json" : "text",
    input: {
      goal: argv._.goal,
      requestId: argv.flags.requestId,
      mode: argv.flags.takeover ? "takeover" : "run",
      projectDir: argv.flags.project,
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
    }
  },
  help: {
    description: "Append a lifecycle status update for a host app run request"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "update-run",
    format: argv.flags.json ? "json" : "text",
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
    }
  },
  help: {
    description: "Cancel a queued or active host app run request"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "cancel-run",
    format: argv.flags.json ? "json" : "text",
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
    }
  },
  help: {
    description: "Consume one pending host app run request with a safe local executor"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "execute-run",
    format: argv.flags.json ? "json" : "text",
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
    description: "Read King loop events from a host run output"
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
    description: "Read King results.tsv rows from a host run output"
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
      description: "Path to .king/heartbeat.json"
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

function hostExportInputFromFlags(flags: { workspace?: string; repo?: string; output?: string; runId?: string; noWorkspace?: boolean; noRepoPatch?: boolean }) {
  return {
    workspaceRoot: flags.workspace,
    repoRoot: flags.repo,
    outputDir: flags.output,
    runId: flags.runId,
    includeWorkspace: flags.noWorkspace ? false : undefined,
    includeRepoPatch: flags.noRepoPatch ? false : undefined
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
    }
  },
  help: {
    description: "Export host artifacts and repo patches to an output directory"
  }
}, async (argv) => {
  const result = await runHostCommandFromCli({
    command: "export",
    format: argv.flags.json ? "json" : "text",
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
    }
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
    input: { limit }
  });
  console.log(argv.flags.json ? JSON.stringify(result.json, null, 2) : result.text);
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
      commands: [hostStatusCommand, hostServeCommand, hostCommandsCommand, hostRunCommand, hostPlanRunCommand, hostPreflightCommand, hostPrepareRunLayoutCommand, hostSubmitRunCommand, hostRunRequestsCommand, hostRunRequestCommand, hostUpdateRunCommand, hostCancelRunCommand, hostExecuteRunCommand, hostEmitRunEventCommand, hostWatchRunCommand, hostRunResultsCommand, hostRunHeartbeatCommand, hostRunMetaCommand, hostPlanExportCommand, hostExportCommand, hostTimelineCommand, hostPolicyCommand],
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
      version: "0.1.0",
      strictFlags: true,
      commands: [agentCommand, skillCheckCommand, projectProfileCommand, usageCommand, hostCommand],
      help: {
        description: "Local BYOA agent daemon",
        examples: [
          `${commandNameFromArgv(process.argv[1])} agent computer --pair abc123 --server https://runtime.example`,
          `${commandNameFromArgv(process.argv[1])} agent computer --doctor`,
          `${commandNameFromArgv(process.argv[1])} usage`,
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
          `${commandNameFromArgv(process.argv[1])} project-profile .`
        ]
      }
    },
    () => {
      const commandName = commandNameFromArgv(process.argv[1]);
      console.log(`Run \`${commandName} --help\` for usage.`);
    }
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    process.stderr.write(`${commandNameFromArgv(process.argv[1])}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(70);
  });
}
