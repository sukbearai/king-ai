#!/usr/bin/env node
import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";

const explicitRoots = process.argv.slice(2);
const envRoot = process.env.AIBC_SKILLS_ROOT;
const candidateRoots =
  explicitRoots.length > 0
    ? explicitRoots
    : [
        envRoot,
        resolve(process.cwd(), "../../skills/skills/skills"),
        resolve(process.cwd(), "../skills/skills/skills"),
        resolve(process.cwd(), "skills/skills/skills"),
      ].filter(Boolean);

const validRoots = candidateRoots.filter((root) => existsSync(root));

if (validRoots.length === 0) {
  console.error(`No shared skill roots found. Checked: ${candidateRoots.join(", ")}`);
  console.error("Pass the directory that directly contains AIBC skill folders, or set AIBC_SKILLS_ROOT.");
  process.exit(1);
}

console.log(`export KING_AI_SHARED_SKILLS=${shellQuote(validRoots.join(delimiter))}`);

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
