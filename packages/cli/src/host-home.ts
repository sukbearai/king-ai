import { existsSync, lstatSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";

export interface HostHomeEntry {
  name: string;
  source: string;
  target: string;
  linked: boolean;
  reason?: string;
}

function splitEntries(value?: string): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((entry, idx, all) => all.indexOf(entry) === idx);
}

export function resolveHostHomeEntryNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return splitEntries(env.KING_HOST_HOME_ENTRIES);
}

export function resolveHostHomeEntry(entry: string, home = homedir()): { name: string; source: string } | null {
  if (entry.includes("..")) return null;
  const expanded = entry.replace(/^~(?=$|\/|\\)/, home);
  const source = isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded);
  const rel = relative(home, source);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.length !== 1) return null;
  const name = basename(source);
  if (!name.startsWith(".")) return null;
  return { name, source };
}

export async function linkHostHomeEntries(agentHome: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<HostHomeEntry[]> {
  const entries: HostHomeEntry[] = [];
  await mkdir(agentHome, { recursive: true });
  for (const raw of resolveHostHomeEntryNames(env)) {
    const resolved = resolveHostHomeEntry(raw, home);
    if (!resolved) {
      entries.push({ name: raw, source: raw, target: "", linked: false, reason: "entry must be a single host-home dotfile or dot directory" });
      continue;
    }
    const target = join(agentHome, resolved.name);
    if (!existsSync(resolved.source)) {
      entries.push({ ...resolved, target, linked: false, reason: "source does not exist" });
      continue;
    }
    const stat = lstatSync(resolved.source);
    await rm(target, { recursive: true, force: true });
    await symlink(resolved.source, target, stat.isDirectory() ? "dir" : "file");
    entries.push({ ...resolved, target, linked: true });
  }
  return entries;
}
