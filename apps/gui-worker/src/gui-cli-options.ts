import type { State, Task } from "./gui-types.js";

export function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export function readBooleanOption(args: string[], name: string): boolean | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const raw = args[idx + 1];
  if (raw === undefined || raw.startsWith("--")) return true;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;
}

export function readNumberOption(args: string[], name: string): number | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeNonnegativeInt(value: string | undefined): number {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function normalizePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function stripOptions(args: string[], optionNames: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (optionNames.includes(args[i] || "")) {
      i += 1;
      continue;
    }
    result.push(args[i] || "");
  }
  return result;
}

export function parseAllowedPaths(args: string[]): string[] {
  const raw = readOption(args, "--paths") || readOption(args, "--path") || "";
  return raw
    .split(",")
    .map((path) => path.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .filter((path, idx, all) => all.indexOf(path) === idx);
}

function pathsOverlap(a: string, b: string): boolean {
  const left = a.replace(/\/+$/, "");
  const right = b.replace(/\/+$/, "");
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function pathConflict(state: State, paths: string[], owner: string, exceptCardId?: string): string | null {
  if (paths.length === 0) return null;
  for (const card of state.cards) {
    if (card.id === exceptCardId || card.column === "done" || !card.claimedBy || card.claimedBy === owner) continue;
    const overlap = (card.allowedPaths ?? []).find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) return `card ${card.id} claimed by ${card.claimedBy} already covers ${overlap}`;
  }
  for (const claim of state.claims) {
    if (claim.owner === owner) continue;
    const overlap = (claim.allowedPaths ?? []).find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) return `claim ${claim.id} held by ${claim.owner} already covers ${overlap}`;
  }
  for (const task of state.tasks) {
    if (task.status === "done" || task.status === "failed" || task.assignee === owner) continue;
    const overlap = (task.scope?.paths ?? []).find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) return `task ${task.id} assigned to ${task.assignee || "unassigned"} already covers ${overlap}`;
  }
  for (const capsule of state.capsules) {
    if (capsule.status !== "open" && capsule.status !== "in_review") continue;
    if (capsule.ownerAgent === owner) continue;
    const overlap = capsule.allowedPaths.find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) return `capsule ${capsule.id} owned by ${capsule.ownerAgent} already covers ${overlap}`;
  }
  return null;
}

export function taskScopeConflicts(state: State, task: Task, owner?: string): string[] {
  const paths = task.scope?.paths ?? [];
  if (paths.length === 0) return [];
  const conflicts: string[] = [];
  for (const other of state.tasks) {
    if (other.id === task.id || other.status === "done" || other.status === "failed") continue;
    if (owner && other.assignee === owner) continue;
    const overlap = (other.scope?.paths ?? []).find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) conflicts.push(`task ${other.id} overlaps ${overlap}`);
  }
  for (const capsule of state.capsules) {
    if (capsule.status !== "open" && capsule.status !== "in_review") continue;
    if (owner && capsule.ownerAgent === owner) continue;
    const overlap = capsule.allowedPaths.find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) conflicts.push(`capsule ${capsule.id} overlaps ${overlap}`);
  }
  return conflicts;
}
