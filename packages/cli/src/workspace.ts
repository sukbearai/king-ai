import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export interface LocalCapabilities {
  workspaces: string[];
  agentWorkspaceRoot?: string;
}

function splitList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
}

export function resolveWorkspaceAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = splitList(env.KING_AI_WORKSPACES);
  const candidates = explicit.length > 0 ? explicit : [resolve(homedir(), "workspace")];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolve(candidate.replace(/^~(?=$|\/|\\)/, homedir()));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (explicit.length > 0 || existsSync(resolved)) result.push(resolved);
  }
  return result;
}

export function detectLocalCapabilities(env: NodeJS.ProcessEnv = process.env): LocalCapabilities {
  return {
    workspaces: resolveWorkspaceAllowlist(env),
    agentWorkspaceRoot: resolveAgentWorkspaceBase(env),
  };
}

export function resolveAgentWorkspaceBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.KING_AI_AGENT_WORKSPACE_ROOT;
  return raw ? resolve(raw.replace(/^~(?=$|\/|\\)/, homedir())) : undefined;
}

export function agentWorkspaceRoot(agentId: string, agentHome: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveAgentWorkspaceBase(env);
  return base ? join(base, agentId) : join(agentHome, "workspace");
}

export function formatWorkspacePolicy(workspaces: string[], agentRoot?: string): string {
  const rootLine = agentRoot
    ? `Agent workspace root: ${agentRoot}. Use this as your default project workspace for clones, builds, downloads, and scratch files.`
    : "";
  if (workspaces.length === 0) {
    return [
      rootLine,
      "Workspace access: no external workspace directories are explicitly allowed. Stay in your agent workspace root unless the operator configures KING_AI_WORKSPACES.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    rootLine,
    "Workspace access: the operator has allowed these external workspace directories for this agent:",
    ...workspaces.map((path) => `- ${path}`),
    "You may read or work in those directories only when the runtime task asks for it. For unrelated scratch work, use your agent workspace root.",
  ]
    .filter(Boolean)
    .join("\n");
}
