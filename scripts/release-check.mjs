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
  const versionPattern = /export const CURRENT_VERSION = "([^"]+)";/;
  if (!versionPattern.test(source)) {
    console.error(`Could not update CURRENT_VERSION in ${pathsSourcePath}`);
    process.exit(1);
  }
  const next = source.replace(versionPattern, `export const CURRENT_VERSION = "${pkg.version}";`);
  if (next === source) return;
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
  run("npm", [
    "pack",
    "./packages/cli",
    "--dry-run"
  ]);
} finally {
  if (existsSync(packageReadmePath)) {
    rmSync(packageReadmePath);
  }
}
