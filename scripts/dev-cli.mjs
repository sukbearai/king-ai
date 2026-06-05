#!/usr/bin/env node

import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = process.argv.slice(2);
let firstArg = 0;
while (args[firstArg] === "--") firstArg += 1;
const cliArgs = ["--filter", "@suwujs/king", "dev", ...args.slice(firstArg)];

if (process.env.KING_CLI_DEV_DRY_RUN === "1") {
  console.log(JSON.stringify({ cliArgs }, null, 2));
  process.exit(0);
}

const child = spawn(pnpm, cliArgs, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
