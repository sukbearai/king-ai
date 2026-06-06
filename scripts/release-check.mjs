import { existsSync, rmSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageReadmePath = "packages/cli/README.md";
const rootPackagePath = "package.json";
const pathsSourcePath = "packages/cli/src/paths.ts";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function syncCliVersion() {
  const pkg = JSON.parse(await readFile(rootPackagePath, "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) {
    console.error(`${rootPackagePath} is missing a version`);
    process.exit(1);
  }

  const source = await readFile(pathsSourcePath, "utf8");
  const next = source.replace(/export const CURRENT_VERSION = "([^"]+)";/, `export const CURRENT_VERSION = "${pkg.version}";`);
  if (next === source) {
    console.error(`Could not update CURRENT_VERSION in ${pathsSourcePath}`);
    process.exit(1);
  }
  await writeFile(pathsSourcePath, next);
}

async function assertCliVersionSynced() {
  const pkg = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const source = await readFile(pathsSourcePath, "utf8");
  if (!source.includes(`export const CURRENT_VERSION = "${pkg.version}";`)) {
    console.error(`CURRENT_VERSION in ${pathsSourcePath} is not synced to ${pkg.version}`);
    process.exit(1);
  }
}

try {
  await syncCliVersion();
  await assertCliVersionSynced();
  run("pnpm", ["verify"]);
  await copyFile("README.md", packageReadmePath);
  run("pnpm", [
    "--filter",
    "@suwujs/king-ai",
    "publish",
    "--dry-run",
    "--no-git-checks"
  ]);
} finally {
  if (existsSync(packageReadmePath)) {
    rmSync(packageReadmePath);
  }
}
