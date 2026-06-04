import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getHostCapsule } from "./host-ledger.js";
import type { HostCapsule } from "./host-ledger.js";
import { isGitRepo } from "./worktree.js";

export interface HostExportInput {
  workspaceRoot?: string;
  repoRoot?: string;
  outputDir?: string;
  runId?: string;
  includeWorkspace?: boolean;
  includeRepoPatch?: boolean;
  capsuleId?: string;
  capsulesFile?: string;
}

export interface HostExportPlan {
  runId: string;
  outputDir: string;
  exportDir: string;
  workspaceRoot?: string;
  repoRoot?: string;
  includeWorkspace: boolean;
  includeRepoPatch: boolean;
  capsuleId?: string;
  capsule?: HostCapsule;
  workspaceFileCount: number;
  repoDirty: boolean;
  files: string[];
  summary: string;
}

export interface HostExportResult extends HostExportPlan {
  writtenFiles: string[];
}

export interface HostExportMeta {
  schema: "king.host-export.v1";
  runId: string;
  exportedAt: string;
  outputDir: string;
  exportDir: string;
  workspaceRoot?: string;
  repoRoot?: string;
  includeWorkspace: boolean;
  includeRepoPatch: boolean;
  capsuleId?: string;
  capsule?: HostCapsule;
  workspaceFileCount: number;
  repoDirty: boolean;
  files: string[];
  writtenFiles: string[];
}

export async function planHostExport(input: HostExportInput = {}): Promise<HostExportPlan> {
  const explicitRunId = cleanString(input.runId);
  const runId = explicitRunId ? safeFilenameSegment(explicitRunId, "runId") : buildExportRunId();
  const outputDir = resolve(cleanString(input.outputDir) || "deliverables");
  const exportDir = join(outputDir, runId);
  const workspaceRoot = resolveOptionalExistingDir(input.workspaceRoot, "workspaceRoot");
  const repoRoot = resolveOptionalExistingDir(input.repoRoot, "repoRoot");
  const includeWorkspace = input.includeWorkspace ?? Boolean(workspaceRoot);
  const includeRepoPatch = input.includeRepoPatch ?? Boolean(repoRoot);
  const capsuleId = cleanString(input.capsuleId);
  const capsule = capsuleId ? await getHostCapsule({ outputDir, capsulesFile: input.capsulesFile, id: capsuleId }) ?? undefined : undefined;
  if (capsuleId && !capsule) throw new Error(`host capsule not found: ${capsuleId}`);
  const workspaceFileCount = includeWorkspace && workspaceRoot ? countFiles(workspaceRoot) : 0;
  const repoDirty = includeRepoPatch && repoRoot ? gitStatus(repoRoot).trim().length > 0 : false;
  const files: string[] = [];
  if (includeWorkspace && workspaceRoot && workspaceFileCount > 0) files.push(`${basename(workspaceRoot) || "workspace"}/`);
  if (includeRepoPatch && repoRoot && repoDirty) {
    files.push("repo-status.txt");
    if (gitDiff(repoRoot, false).trim()) files.push("repo.patch");
    if (gitDiff(repoRoot, true).trim()) files.push("repo-staged.patch");
  }
  if (capsule) files.push("capsule.json");
  files.push("meta.json");
  const plan: HostExportPlan = {
    runId,
    outputDir,
    exportDir,
    workspaceRoot,
    repoRoot,
    includeWorkspace,
    includeRepoPatch,
    capsuleId,
    capsule,
    workspaceFileCount,
    repoDirty,
    files,
    summary: ""
  };
  plan.summary = formatHostExportPlan(plan);
  return plan;
}

export async function exportHostArtifacts(input: HostExportInput = {}): Promise<HostExportResult> {
  const plan = await planHostExport(input);
  const writtenFiles: string[] = [];
  await rm(plan.exportDir, { recursive: true, force: true });
  await mkdir(plan.exportDir, { recursive: true });

  if (plan.includeWorkspace && plan.workspaceRoot && plan.workspaceFileCount > 0) {
    const target = join(plan.exportDir, basename(plan.workspaceRoot) || "workspace");
    await cp(plan.workspaceRoot, target, {
      recursive: true,
      force: true,
      dereference: false,
      filter: (source) => !shouldSkipExportPath(source)
    });
    writtenFiles.push(target);
  }

  if (plan.includeRepoPatch && plan.repoRoot && plan.repoDirty) {
    const status = gitStatus(plan.repoRoot);
    await writeFile(join(plan.exportDir, "repo-status.txt"), status, "utf8");
    writtenFiles.push(join(plan.exportDir, "repo-status.txt"));
    const diff = gitDiff(plan.repoRoot, false);
    if (diff.trim()) {
      await writeFile(join(plan.exportDir, "repo.patch"), diff, "utf8");
      writtenFiles.push(join(plan.exportDir, "repo.patch"));
    }
    const staged = gitDiff(plan.repoRoot, true);
    if (staged.trim()) {
      await writeFile(join(plan.exportDir, "repo-staged.patch"), staged, "utf8");
      writtenFiles.push(join(plan.exportDir, "repo-staged.patch"));
    }
  }

  if (plan.capsule) {
    const capsulePath = join(plan.exportDir, "capsule.json");
    await writeFile(capsulePath, `${JSON.stringify(plan.capsule, null, 2)}\n`, "utf8");
    writtenFiles.push(capsulePath);
  }

  const metaPath = join(plan.exportDir, "meta.json");
  writtenFiles.push(metaPath);
  const meta = createHostExportMeta(plan, writtenFiles);
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  return {
    ...plan,
    writtenFiles
  };
}

export function formatHostExportPlan(plan: HostExportPlan): string {
  const lines = [
    `host export: ${plan.runId}`,
    `output: ${plan.exportDir}`,
    `workspace: ${plan.workspaceRoot ?? "(none)"} files=${plan.workspaceFileCount}`,
    `repo: ${plan.repoRoot ?? "(none)"} dirty=${plan.repoDirty ? "yes" : "no"}`,
    `capsule: ${plan.capsule?.id ?? "(none)"}`
  ];
  if (plan.files.length) {
    lines.push("planned files:");
    for (const file of plan.files) lines.push(`  - ${file}`);
  } else {
    lines.push("planned files: (none)");
  }
  return lines.join("\n");
}

export function createHostExportMeta(plan: HostExportPlan, writtenFiles: string[], now: Date = new Date()): HostExportMeta {
  return {
    schema: "king.host-export.v1",
    runId: plan.runId,
    exportedAt: now.toISOString(),
    outputDir: plan.outputDir,
    exportDir: plan.exportDir,
    workspaceRoot: plan.workspaceRoot,
    repoRoot: plan.repoRoot,
    includeWorkspace: plan.includeWorkspace,
    includeRepoPatch: plan.includeRepoPatch,
    capsuleId: plan.capsuleId,
    capsule: plan.capsule,
    workspaceFileCount: plan.workspaceFileCount,
    repoDirty: plan.repoDirty,
    files: plan.files,
    writtenFiles
  };
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeFilenameSegment(value: string, label: string): string {
  if (value === "." || value === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe filename segment`);
  }
  return value;
}

function buildExportRunId(): string {
  return `export-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

function resolveOptionalExistingDir(value: unknown, label: string): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const resolved = resolve(cleaned);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  if (label === "repoRoot" && !isGitRepo(resolved)) throw new Error(`${label} is not a git repository: ${resolved}`);
  return resolved;
}

function shouldSkipExportPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return /(^|\/)(\.git|node_modules|\.DS_Store)$/.test(normalized);
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function gitStatus(repoRoot: string): string {
  return execFileSync("git", ["-C", repoRoot, "status", "--short"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function gitDiff(repoRoot: string, staged: boolean): string {
  return execFileSync("git", ["-C", repoRoot, "diff", "--binary", ...(staged ? ["--cached"] : [])], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
