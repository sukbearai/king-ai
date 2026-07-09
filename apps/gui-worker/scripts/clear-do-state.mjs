#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(scriptDir, "..");
const wranglerTomlPath = join(workerRoot, "wrangler.toml");
const DEFAULT_URL = "http://127.0.0.1:8787";

function usage() {
  console.log(`Usage: node scripts/clear-do-state.mjs [options]

Clear persisted GuiState Durable Object storage.

Modes (default: local file wipe):
  --local                 Delete wrangler local DO sqlite files (default)
  --remote, --url <base>  POST /gui/reset-state on a running GUI worker

Options:
  --tenant <id>           Tenant for --remote (default: global)
  --cookie <value>        Cookie header for authenticated deployments
  --yes, -y               Skip confirmation prompt
  --dry-run               Show what would be removed without deleting
  -h, --help              Show this help

Examples:
  pnpm --filter @king-ai/gui-worker run clear-do
  pnpm --filter @king-ai/gui-worker run clear-do -- --remote --tenant global
  pnpm --filter @king-ai/gui-worker run clear-do -- --url https://your-gui.example --cookie "session=..." -y
`);
}

function parseArgs(argv) {
  let firstArg = 0;
  while (argv[firstArg] === "--") firstArg += 1;
  const args = argv.slice(firstArg);

  const options = {
    mode: "local",
    url: process.env.KING_AI_GUI_URL || DEFAULT_URL,
    tenant: "global",
    cookie: process.env.KING_AI_GUI_COOKIE || "",
    yes: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--local") {
      options.mode = "local";
      continue;
    }
    if (arg === "--remote") {
      options.mode = "remote";
      continue;
    }
    if (arg === "--url") {
      options.mode = "remote";
      options.url = args[++index] ?? "";
      continue;
    }
    if (arg === "--tenant") {
      options.tenant = args[++index] ?? "global";
      continue;
    }
    if (arg === "--cookie") {
      options.cookie = args[++index] ?? "";
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }

  return options;
}

function readWranglerBinding() {
  const text = readFileSync(wranglerTomlPath, "utf8");
  const name = text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "king-ai-gui";
  const className = text.match(/class_name\s*=\s*"([^"]+)"/m)?.[1] ?? "GuiState";
  return { name, className, namespaceDir: `${name}-${className}` };
}

function listLocalDoTargets() {
  const { namespaceDir } = readWranglerBinding();
  const doRoot = join(workerRoot, ".wrangler/state/v3/do");
  if (!existsSync(doRoot)) return [];

  const targets = [];
  for (const entry of readdirSync(doRoot)) {
    if (!entry.endsWith("-GuiState")) continue;
    const dir = join(doRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter((file) => file.endsWith(".sqlite"));
    for (const file of files) targets.push({ dir, file, namespace: entry, current: entry === namespaceDir });
  }
  return targets;
}

function clearLocalDoState(options) {
  const targets = listLocalDoTargets();
  if (!targets.length) {
    console.log("No local GuiState DO sqlite files found under apps/gui-worker/.wrangler/state/v3/do.");
    return;
  }

  const rows = targets.map((row) => join(row.dir, row.file));
  console.log("Local GuiState DO files to remove:");
  for (const row of targets) {
    console.log(`  - ${row.namespace}/${row.file}${row.current ? " (current worker)" : " (legacy namespace)"}`);
  }

  if (options.dryRun) {
    console.log(`Dry run: would remove ${rows.length} sqlite file(s). Restart wrangler dev to pick up a clean DO.`);
    return;
  }

  if (!options.yes) {
    console.error("Refusing to delete without --yes. Local DO wipe is destructive.");
    process.exit(1);
  }

  let removed = 0;
  for (const path of rows) {
    rmSync(path, { force: true });
    removed += 1;
  }
  console.log(`Removed ${removed} local GuiState DO sqlite file(s). Restart wrangler dev before testing again.`);
}

async function resetRemoteDoState(options) {
  const base = options.url.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (options.tenant) headers["X-King-AI-Tenant"] = options.tenant;
  if (options.cookie) headers.Cookie = options.cookie;

  if (options.dryRun) {
    console.log(`Dry run: would POST ${base}/gui/reset-state with tenant=${options.tenant}`);
    return;
  }

  if (!options.yes) {
    console.error("Refusing to reset remote DO state without --yes.");
    process.exit(1);
  }

  const response = await fetch(`${base}/gui/reset-state`, {
    method: "POST",
    headers,
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`Reset failed (${response.status}): ${body}`);
    process.exit(1);
  }
  console.log(`Reset OK (${response.status}) tenant=${options.tenant}: ${body}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

if (options.mode === "remote") {
  await resetRemoteDoState(options);
} else {
  clearLocalDoState(options);
}
