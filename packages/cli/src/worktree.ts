import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileP = promisify(execFile);

export interface WorktreePlan {
  repoRoot: string;
  repoName: string;
  repoUrl?: string;
  branch: string;
  worktreePath: string;
  command: string[];
}

export type WorktreePreparationStatus = "planned" | "created" | "exists" | "failed";
export type WorktreeCleanupStatus = "missing" | "present" | "removed" | "failed";

export interface WorktreePreparationResult {
  plan: WorktreePlan;
  status: WorktreePreparationStatus;
  commandText: string;
  detail?: string;
}

export interface WorktreeCleanupResult {
  plan: WorktreePlan;
  status: WorktreeCleanupStatus;
  commandText: string;
  detail?: string;
}

export type WorktreeExecutor = (file: string, args: string[]) => Promise<unknown>;

export function safeBranchSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "agent"
  );
}

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

const SSH_GITHUB_REPO_RE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i;

function hasValidRepoPathname(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return false;
  return segments.every((segment, index) => {
    const normalized = index === 1 ? segment.replace(/\.git$/i, "") : segment;
    return normalized.length > 0 && !normalized.startsWith(".");
  });
}

export function isGitHubRepoUrl(repoUrl: string): boolean {
  const trimmed = repoUrl.trim();
  if (!trimmed) return false;
  if (SSH_GITHUB_REPO_RE.test(trimmed)) return true;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (!["https:", "http:", "ssh:"].includes(parsed.protocol)) return false;
  if (parsed.hostname.toLowerCase() !== "github.com") return false;
  if (parsed.username && parsed.username !== "git") return false;
  if (parsed.password || parsed.search || parsed.hash) return false;
  return hasValidRepoPathname(parsed.pathname);
}

export function gitOriginUrl(repoRoot: string): string | undefined {
  const configPath = join(repoRoot, ".git", "config");
  if (!existsSync(configPath)) return undefined;
  const config = readFileSync(configPath, "utf8");
  const lines = config.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/);
    if (section) {
      inOrigin = section[1] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (url?.[1]) return url[1];
  }
  return undefined;
}

export function githubRepoUrl(repoRoot: string): string | undefined {
  const origin = gitOriginUrl(repoRoot);
  return origin && isGitHubRepoUrl(origin) ? origin : undefined;
}

export function planAgentWorktrees(args: { agentId: string; workspaces: string[]; baseRoot?: string }): WorktreePlan[] {
  const agentSegment = safeBranchSegment(args.agentId);
  return args.workspaces
    .filter((workspace) => isGitRepo(workspace))
    .map((repoRoot) => {
      const repoName = basename(repoRoot) || "repo";
      const branch = `agent/${agentSegment}`;
      const worktreePath = args.baseRoot ? join(args.baseRoot, repoName) : join(repoRoot, ".worktrees", agentSegment);
      return {
        repoRoot,
        repoName,
        repoUrl: githubRepoUrl(repoRoot),
        branch,
        worktreePath,
        command: ["git", "-C", repoRoot, "worktree", "add", "-B", branch, worktreePath],
      };
    });
}

export function formatWorktreePlanForPrompt(plans: WorktreePlan[]): string {
  if (plans.length === 0) return "";
  return [
    "Planned git worktree isolation (not auto-created by the daemon):",
    ...plans.map(
      (plan) =>
        `- ${plan.repoName}: ${plan.worktreePath} on ${plan.branch}${plan.repoUrl ? ` from ${plan.repoUrl}` : ""}`,
    ),
  ].join("\n");
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function commandText(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

export async function prepareWorktreePlans(
  plans: WorktreePlan[],
  options: { execute?: boolean; executor?: WorktreeExecutor } = {},
): Promise<WorktreePreparationResult[]> {
  const executor = options.executor ?? ((file, args) => execFileP(file, args));
  const results: WorktreePreparationResult[] = [];
  for (const plan of plans) {
    const command = commandText(plan.command);
    if (existsSync(plan.worktreePath)) {
      results.push({ plan, status: "exists", commandText: command, detail: "worktree path already exists" });
      continue;
    }
    if (!options.execute) {
      results.push({ plan, status: "planned", commandText: command });
      continue;
    }
    try {
      await mkdir(dirname(plan.worktreePath), { recursive: true });
      const [file, ...args] = plan.command;
      if (!file) throw new Error("empty worktree command");
      await executor(file, args);
      results.push({ plan, status: "created", commandText: command });
    } catch (err) {
      results.push({
        plan,
        status: "failed",
        commandText: command,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function formatWorktreePreparationResults(results: WorktreePreparationResult[], execute = false): string {
  if (results.length === 0) return "no worktree plans found";
  const lines = [`worktree preparation${execute ? "" : " (dry run)"}`];
  for (const result of results) {
    lines.push(`- ${result.plan.repoName}: ${result.status}`);
    lines.push(`  repo: ${result.plan.repoRoot}`);
    if (result.plan.repoUrl) lines.push(`  origin: ${result.plan.repoUrl}`);
    lines.push(`  path: ${result.plan.worktreePath}`);
    lines.push(`  branch: ${result.plan.branch}`);
    lines.push(`  command: ${result.commandText}`);
    if (result.detail) lines.push(`  detail: ${result.detail}`);
  }
  if (!execute) lines.push("rerun with --yes to create these worktrees");
  return lines.join("\n");
}

export function cleanupCommand(plan: WorktreePlan): string[] {
  return ["git", "-C", plan.repoRoot, "worktree", "remove", "--force", plan.worktreePath];
}

export async function cleanupWorktreePlans(
  plans: WorktreePlan[],
  options: { execute?: boolean; executor?: WorktreeExecutor } = {},
): Promise<WorktreeCleanupResult[]> {
  const executor = options.executor ?? ((file, args) => execFileP(file, args));
  const results: WorktreeCleanupResult[] = [];
  for (const plan of plans) {
    const removeCommand = cleanupCommand(plan);
    const command = commandText(removeCommand);
    if (!existsSync(plan.worktreePath)) {
      results.push({ plan, status: "missing", commandText: command, detail: "worktree path does not exist" });
      continue;
    }
    if (!options.execute) {
      results.push({ plan, status: "present", commandText: command });
      continue;
    }
    try {
      const [file, ...args] = removeCommand;
      if (!file) throw new Error("empty cleanup command");
      await executor(file, args);
      results.push({ plan, status: "removed", commandText: command });
    } catch (err) {
      results.push({
        plan,
        status: "failed",
        commandText: command,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function formatWorktreeCleanupResults(results: WorktreeCleanupResult[], execute = false): string {
  if (results.length === 0) return "no worktree plans found";
  const lines = [`worktree cleanup${execute ? "" : " (dry run)"}`];
  for (const result of results) {
    lines.push(`- ${result.plan.repoName}: ${result.status}`);
    lines.push(`  repo: ${result.plan.repoRoot}`);
    if (result.plan.repoUrl) lines.push(`  origin: ${result.plan.repoUrl}`);
    lines.push(`  path: ${result.plan.worktreePath}`);
    lines.push(`  branch: ${result.plan.branch}`);
    lines.push(`  command: ${result.commandText}`);
    if (result.detail) lines.push(`  detail: ${result.detail}`);
  }
  if (!execute) lines.push("rerun with --yes to remove present worktrees");
  return lines.join("\n");
}
