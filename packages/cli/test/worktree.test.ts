import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanupCommand,
  cleanupWorktreePlans,
  commandText,
  formatWorktreeCleanupResults,
  formatWorktreePlanForPrompt,
  formatWorktreePreparationResults,
  gitOriginUrl,
  githubRepoUrl,
  isGitRepo,
  isGitHubRepoUrl,
  planAgentWorktrees,
  prepareWorktreePlans,
  safeBranchSegment
} from "../src/worktree.js";

test("safeBranchSegment normalizes agent ids for git branches", () => {
  assert.equal(safeBranchSegment("Demo Agent/One"), "Demo-Agent-One");
  assert.equal(safeBranchSegment(""), "agent");
});

test("planAgentWorktrees creates non-executing git worktree plans for git repos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-worktree-"));
  const repo = join(dir, "repo");
  const plain = join(dir, "plain");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(plain, { recursive: true });

  assert.equal(isGitRepo(repo), true);
  assert.equal(isGitRepo(plain), false);

  const plans = planAgentWorktrees({ agentId: "demo/agent", workspaces: [repo, plain], baseRoot: join(dir, "agents", "demo-agent") });
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.branch, "agent/demo-agent");
  assert.equal(plans[0]?.worktreePath, join(dir, "agents", "demo-agent", "repo"));
  assert.deepEqual(plans[0]?.command, ["git", "-C", repo, "worktree", "add", "-B", "agent/demo-agent", plans[0]?.worktreePath]);
  assert.match(formatWorktreePlanForPrompt(plans), /Planned git worktree isolation/);
});

test("isGitRepo accepts gitdir files from existing worktrees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-gitfile-"));
  await writeFile(join(dir, ".git"), "gitdir: ../main/.git/worktrees/agent\n", "utf8");
  assert.equal(isGitRepo(dir), true);
});

test("isGitHubRepoUrl accepts canonical GitHub repository remotes only", () => {
  assert.equal(isGitHubRepoUrl("https://github.com/acme/repo"), true);
  assert.equal(isGitHubRepoUrl("https://github.com/acme/repo.git"), true);
  assert.equal(isGitHubRepoUrl("git@github.com:acme/repo.git"), true);
  assert.equal(isGitHubRepoUrl("ssh://git@github.com/acme/repo.git"), true);
  assert.equal(isGitHubRepoUrl("https://github.com/acme/repo/issues"), false);
  assert.equal(isGitHubRepoUrl("https://github.com/acme/repo?ref=main"), false);
  assert.equal(isGitHubRepoUrl("https://gitlab.com/acme/repo"), false);
  assert.equal(isGitHubRepoUrl(""), false);
});

test("planAgentWorktrees includes valid GitHub origin metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-worktree-origin-"));
  const repo = join(dir, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "config"), [
    '[remote "origin"]',
    "  url = git@github.com:acme/repo.git"
  ].join("\n"), "utf8");

  assert.equal(gitOriginUrl(repo), "git@github.com:acme/repo.git");
  assert.equal(githubRepoUrl(repo), "git@github.com:acme/repo.git");
  const [plan] = planAgentWorktrees({ agentId: "demo-agent", workspaces: [repo] });
  assert.equal(plan?.repoUrl, "git@github.com:acme/repo.git");
  assert.match(formatWorktreePlanForPrompt(plan ? [plan] : []), /from git@github\.com:acme\/repo\.git/);
  assert.match(formatWorktreePreparationResults(plan ? await prepareWorktreePlans([plan]) : []), /origin: git@github\.com:acme\/repo\.git/);
});

test("commandText quotes shell-sensitive worktree commands", () => {
  assert.equal(commandText(["git", "-C", "/tmp/my repo", "status"]), "git -C '/tmp/my repo' status");
});

test("prepareWorktreePlans dry-runs plans and can create missing worktrees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-worktree-prepare-"));
  const repo = join(dir, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const [plan] = planAgentWorktrees({ agentId: "demo-agent", workspaces: [repo], baseRoot: join(dir, "agents", "demo-agent") });
  assert.ok(plan);

  const dryRun = await prepareWorktreePlans([plan]);
  assert.equal(dryRun[0]?.status, "planned");
  assert.match(formatWorktreePreparationResults(dryRun), /rerun with --yes/);

  const calls: Array<[string, string[]]> = [];
  const executed = await prepareWorktreePlans([plan], {
    execute: true,
    executor: async (file, args) => {
      calls.push([file, args]);
    }
  });
  assert.equal(executed[0]?.status, "created");
  assert.deepEqual(calls, [["git", ["-C", repo, "worktree", "add", "-B", "agent/demo-agent", plan.worktreePath]]]);
});

test("prepareWorktreePlans skips existing worktree paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-worktree-existing-"));
  const repo = join(dir, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const [plan] = planAgentWorktrees({ agentId: "demo-agent", workspaces: [repo], baseRoot: join(dir, "agents", "demo-agent") });
  assert.ok(plan);
  await mkdir(plan.worktreePath, { recursive: true });

  const calls: Array<[string, string[]]> = [];
  const result = await prepareWorktreePlans([plan], {
    execute: true,
    executor: async (file, args) => {
      calls.push([file, args]);
    }
  });
  assert.equal(result[0]?.status, "exists");
  assert.equal(calls.length, 0);
});

test("cleanupWorktreePlans dry-runs and removes existing planned worktrees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-worktree-cleanup-"));
  const repo = join(dir, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const [plan] = planAgentWorktrees({ agentId: "demo-agent", workspaces: [repo], baseRoot: join(dir, "agents", "demo-agent") });
  assert.ok(plan);
  await mkdir(plan.worktreePath, { recursive: true });

  assert.deepEqual(cleanupCommand(plan), ["git", "-C", repo, "worktree", "remove", "--force", plan.worktreePath]);
  const dryRun = await cleanupWorktreePlans([plan]);
  assert.equal(dryRun[0]?.status, "present");
  assert.match(formatWorktreeCleanupResults(dryRun), /rerun with --yes/);

  const calls: Array<[string, string[]]> = [];
  const executed = await cleanupWorktreePlans([plan], {
    execute: true,
    executor: async (file, args) => {
      calls.push([file, args]);
    }
  });
  assert.equal(executed[0]?.status, "removed");
  assert.deepEqual(calls, [["git", ["-C", repo, "worktree", "remove", "--force", plan.worktreePath]]]);
});

test("cleanupWorktreePlans skips missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-worktree-cleanup-missing-"));
  const repo = join(dir, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const [plan] = planAgentWorktrees({ agentId: "demo-agent", workspaces: [repo], baseRoot: join(dir, "agents", "demo-agent") });
  assert.ok(plan);

  const calls: Array<[string, string[]]> = [];
  const result = await cleanupWorktreePlans([plan], {
    execute: true,
    executor: async (file, args) => {
      calls.push([file, args]);
    }
  });
  assert.equal(result[0]?.status, "missing");
  assert.equal(calls.length, 0);
});
