import { existsSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageReadmePath = "packages/cli/README.md";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

try {
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
