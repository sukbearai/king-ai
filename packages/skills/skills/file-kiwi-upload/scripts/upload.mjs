#!/usr/bin/env node

import { accessSync, chmodSync, constants, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLIENT_PACKAGE = "@file-kiwi/node@1.0.9";
const API_BASE = "https://api.file.kiwi";
const NPM_REGISTRY = "https://registry.npmjs.org";
const MAX_FILES = 10;
const MAX_FILE_BYTES = 999 * 1024 ** 3;
const MAX_TITLE_LENGTH = 200;

function usage() {
  return `Usage:
  upload.mjs --dry-run [--title <title>] -- <file> [<file> ...]
  upload.mjs --confirm-external-upload [--title <title>] -- <file> [<file> ...]
  upload.mjs --confirm-external-upload --resume <folder-id>

Options:
  --confirm-external-upload  Required before any file data is transmitted
  --dry-run                  Validate and print the upload plan without network access
  --title <title>            Optional WebFolder title, maximum 200 characters
  --resume <folder-id>       Resume a prior upload from the private state directory
  --state-dir <path>         Override the state directory
  --help                     Show this help`;
}

export function parseArgs(argv) {
  const options = {
    confirmed: false,
    dryRun: false,
    files: [],
    resumeId: null,
    stateDir: process.env.FILE_KIWI_UPLOAD_STATE_DIR || path.join(homedir(), ".king-ai", "file-kiwi-upload"),
    title: null,
  };

  let filesOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (filesOnly) {
      options.files.push(argument);
      continue;
    }
    if (argument === "--") {
      filesOnly = true;
    } else if (argument === "--confirm-external-upload") {
      options.confirmed = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--title" || argument === "--resume" || argument === "--state-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--title") options.title = value;
      if (argument === "--resume") options.resumeId = value;
      if (argument === "--state-dir") options.stateDir = value;
    } else {
      options.files.push(argument);
    }
  }

  return options;
}

function validateTitle(title) {
  if (title !== null && (title.length === 0 || title.length > MAX_TITLE_LENGTH)) {
    throw new Error(`Title must contain 1-${MAX_TITLE_LENGTH} characters`);
  }
}

function validateResumeId(resumeId) {
  if (!/^[A-Za-z0-9_-]+$/.test(resumeId)) {
    throw new Error("Resume folder ID contains unsupported characters");
  }
}

export function buildPlan(options) {
  validateTitle(options.title);

  if (options.dryRun && options.resumeId) {
    throw new Error("--dry-run cannot be combined with --resume");
  }
  if (options.resumeId && options.files.length > 0) {
    throw new Error("--resume cannot be combined with file paths");
  }
  if (!options.dryRun && !options.confirmed) {
    throw new Error("External upload is not confirmed; run a dry-run and obtain explicit user confirmation first");
  }

  const stateDir = path.resolve(options.stateDir);
  if (options.resumeId) {
    validateResumeId(options.resumeId);
    const stateFile = path.join(stateDir, `filekiwi.tmp.${options.resumeId}.json`);
    if (!existsSync(stateFile) || !statSync(stateFile).isFile()) {
      throw new Error(`Resume state not found: ${stateFile}`);
    }
    return {
      clientPackage: CLIENT_PACKAGE,
      destination: "https://file.kiwi",
      mode: "resume",
      resumeId: options.resumeId,
      stateDir,
      stateFile,
    };
  }

  if (options.files.length === 0 || options.files.length > MAX_FILES) {
    throw new Error(`Select 1-${MAX_FILES} explicit file paths`);
  }

  const files = options.files.map((file) => {
    const resolved = realpathSync(path.resolve(file));
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${resolved}`);
    accessSync(resolved, constants.R_OK);
    if (stat.size <= 0) throw new Error(`Empty files are not accepted by the public API: ${resolved}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds the 999 GiB public API limit: ${resolved}`);
    return { path: resolved, size: stat.size };
  });

  return {
    clientPackage: CLIENT_PACKAGE,
    destination: "https://file.kiwi",
    files,
    mode: options.dryRun ? "dry-run" : "upload",
    stateDir,
    title: options.title,
    warning: "The returned URL fragment is the decryption key and grants file access.",
  };
}

function runOfficialClient(plan) {
  process.umask(0o077);
  mkdirSync(plan.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(plan.stateDir, 0o700);
  if (plan.mode === "resume") chmodSync(plan.stateFile, 0o600);

  const clientArgs = ["exec", `--registry=${NPM_REGISTRY}`, "--yes", `--package=${CLIENT_PACKAGE}`, "--", "filekiwi"];
  if (plan.mode === "resume") {
    clientArgs.push("--resume", plan.resumeId);
  } else {
    if (plan.title) clientArgs.push("--title", plan.title);
    clientArgs.push(...plan.files.map((file) => file.path));
  }

  const result = spawnSync("npm", clientArgs, {
    cwd: plan.stateDir,
    env: { ...process.env, FILEKIWI_API: API_BASE },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Official file.kiwi client stopped by signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`Official file.kiwi client exited with status ${result.status}`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const plan = buildPlan(options);
  if (plan.mode === "dry-run") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  process.stderr.write(`${JSON.stringify(plan, null, 2)}\n`);
  runOfficialClient(plan);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`file-kiwi-upload: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
