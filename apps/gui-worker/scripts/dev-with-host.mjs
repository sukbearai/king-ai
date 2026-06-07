#!/usr/bin/env node

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_HOST_URL = "http://127.0.0.1:8799";
const HOST_READY_TIMEOUT_MS = 6000;
const HOST_READY_INTERVAL_MS = 250;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const wranglerArgs = normalizeWranglerArgs(process.argv.slice(2));
const hostUrl = process.env.KING_AI_HOST_URL || DEFAULT_HOST_URL;
const shouldAutostartHost = process.env.KING_AI_HOST_AUTOSTART !== "0" && hostUrl === DEFAULT_HOST_URL;
const hostArgs = ["--filter", "@suwujs/king-ai", "dev", "host", "serve"];
const guiArgs = ["exec", "wrangler", "dev", "--config", "wrangler.toml", ...wranglerArgs];
const children = new Set();
let shuttingDown = false;

function normalizeWranglerArgs(args) {
  let firstArg = 0;
  while (args[firstArg] === "--") firstArg += 1;
  return args.slice(firstArg);
}

function spawnChild(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: "inherit"
  });
  children.add(child);
  child.on("error", (err) => {
    console.error(`[${label}] ${err.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) shutdown(code ?? (signal ? 1 : 0));
  });
  return child;
}

async function hostReady(url) {
  try {
    const response = await fetch(new URL("/health", url), {
      signal: AbortSignal.timeout(1000)
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => undefined);
    return Boolean(body && body.ok);
  } catch {
    return false;
  }
}

async function waitForHost(url) {
  const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (await hostReady(url)) return true;
    await delay(HOST_READY_INTERVAL_MS);
  }
  return false;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 1500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

// Orphan watchdog: if the process that launched us (a terminal, pnpm, or Codex) exits,
// this process is reparented to PID 1. Detached children would otherwise keep polling the
// server forever and could trip DDoS protection, so self-terminate — which tears down the
// whole child tree — as soon as we detect we have been orphaned.
const initialPpid = process.ppid;
if (initialPpid !== 1) {
  setInterval(() => {
    if (process.ppid === 1) {
      console.warn("[gui] launcher process exited; shutting down dev stack to avoid orphaned processes");
      shutdown(0);
    }
  }, 5000).unref();
}

if (process.env.KING_AI_GUI_DEV_DRY_RUN === "1") {
  console.log(JSON.stringify({
    hostUrl,
    shouldAutostartHost,
    hostArgs,
    wranglerArgs: guiArgs
  }, null, 2));
  process.exit(0);
}

if (shouldAutostartHost) {
  if (await hostReady(hostUrl)) {
    console.log(`[gui] using existing King AI host server at ${hostUrl}`);
  } else {
    console.log(`[gui] starting King AI host server at ${hostUrl}`);
    spawnChild("host", pnpm, hostArgs);
    if (!(await waitForHost(hostUrl))) {
      console.warn(`[gui] King AI host server was not ready within ${HOST_READY_TIMEOUT_MS}ms; GUI will keep retrying through ${hostUrl}`);
    }
  }
} else if (!process.env.KING_AI_HOST_URL) {
  console.warn("[gui] KING_AI_HOST_AUTOSTART=0 set without KING_AI_HOST_URL; host bridge features will be unavailable.");
}

spawnChild("gui", pnpm, guiArgs, {
  env: { KING_AI_HOST_URL: hostUrl }
});
