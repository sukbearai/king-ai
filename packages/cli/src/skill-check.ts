import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const KNOWN_COMMANDS = new Set([
  "agent",
  "agents",
  "agenda",
  "artifact",
  "calendar",
  "capsule",
  "card",
  "claim",
  "contacts",
  "context",
  "dm",
  "doc",
  "escalate",
  "eval",
  "evaluate",
  "feedback",
  "glance",
  "hypothesis",
  "inbox",
  "initiative",
  "loop",
  "messages",
  "merge",
  "observe",
  "participants",
  "preamble",
  "plan",
  "react",
  "reaction",
  "recv",
  "reply",
  "review",
  "route",
  "roster",
  "safety",
  "send",
  "status",
  "task",
  "unclaim",
  "watch",
  "whoami"
]);

export const KNOWN_SUBCOMMANDS: Record<string, Set<string>> = {
  agent: new Set(["computer"]),
  agents: new Set(["spawn", "destroy"]),
  artifact: new Set(["put", "list", "get", "check"]),
  calendar: new Set(["list", "create"]),
  capsule: new Set(["create", "list", "mine", "get", "update"]),
  card: new Set(["list", "create", "claim", "move", "done", "release"]),
  context: new Set(["get", "set", "list", "delete"]),
  doc: new Set(["list", "create", "show", "append", "update"]),
  eval: new Set(["parse", "record", "list", "get"]),
  evaluate: new Set(["parse", "record", "list", "get"]),
  feedback: new Set(["record", "list", "summary", "get"]),
  hypothesis: new Set(["create", "list", "update"]),
  safety: new Set(["check", "request", "list", "get", "approve", "deny", "pending"]),
  initiative: new Set(["create", "list", "get", "update", "advance", "persist"]),
  loop: new Set(["tick", "emit", "classify", "recent", "snapshot", "list"]),
  merge: new Set(["enqueue", "list", "get", "mark"]),
  plan: new Set(["parse", "apply"]),
  review: new Set(["record", "list", "get"]),
  route: new Set(["set", "list", "delete", "remove", "emit"]),
  task: new Set(["create", "list", "get", "update", "done"])
};

export interface SkillCheckResult {
  skillName: string;
  filePath: string;
  referencedCommands: string[];
  invalidCommands: string[];
  warnings: string[];
  valid: boolean;
}

export function extractCommands(content: string): string[] {
  const commands: string[] = [];
  const regex = /\bking-ai\s+([a-z][\w:-]*)(?:\s+([a-z][\w:-]*))?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const topLevel = match[1];
    const subcommand = match[2];
    if (!topLevel) continue;
    if (subcommand && KNOWN_SUBCOMMANDS[topLevel]) {
      commands.push(`${topLevel} ${subcommand}`);
      continue;
    }
    commands.push(topLevel);
  }
  return [...new Set(commands)];
}

export function validateCommand(commandReference: string): boolean {
  const [topLevel, subcommand] = commandReference.split(" ");
  if (!topLevel || !KNOWN_COMMANDS.has(topLevel)) return false;
  if (!subcommand) return true;
  return KNOWN_SUBCOMMANDS[topLevel]?.has(subcommand) ?? true;
}

export function checkSkill(filePath: string): SkillCheckResult {
  const content = readFileSync(filePath, "utf8");
  const referencedCommands = extractCommands(content);
  const invalidCommands = referencedCommands.filter((commandReference) => !validateCommand(commandReference));
  const warnings: string[] = [];
  if (referencedCommands.length === 0) warnings.push("No king-ai CLI commands referenced");
  return {
    skillName: basename(dirname(filePath)),
    filePath,
    referencedCommands,
    invalidCommands,
    warnings,
    valid: invalidCommands.length === 0
  };
}

export function findSkillFiles(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const entryPath = join(skillsDir, entry.name);
    if (entry.isDirectory()) {
      const skillFile = join(entryPath, "SKILL.md");
      if (existsSync(skillFile)) files.push(skillFile);
      files.push(...findSkillFiles(entryPath));
    }
  }
  return [...new Set(files)].sort();
}

export function checkAllSkills(skillsDir: string): SkillCheckResult[] {
  return findSkillFiles(skillsDir).map((filePath) => checkSkill(filePath));
}

export function formatDashboard(results: SkillCheckResult[], commandName = "king-ai"): string {
  const lines: string[] = [
    `${commandName} skill-check - Skill command reference health`,
    "=".repeat(56)
  ];
  let passed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.valid) passed++;
    else failed++;
    lines.push(`${result.valid ? "[ok]" : "[fail]"} ${result.skillName}`);
    lines.push(`  Commands: ${result.referencedCommands.length ? result.referencedCommands.join(", ") : "none"}`);
    if (result.invalidCommands.length) lines.push(`  Invalid: ${result.invalidCommands.join(", ")}`);
    for (const warning of result.warnings) lines.push(`  [warn] ${warning}`);
  }
  lines.push("-".repeat(56));
  lines.push(`Total: ${results.length} skills, ${passed} passed, ${failed} failed`);
  return lines.join("\n");
}

export function runSkillCheck(skillsDir: string, commandName = "king-ai"): void {
  if (!existsSync(skillsDir)) {
    throw new Error(`Skills directory not found: ${skillsDir}`);
  }
  const results = checkAllSkills(skillsDir);
  console.log(formatDashboard(results, commandName));
  if (results.some((result) => !result.valid)) process.exitCode = 1;
}
