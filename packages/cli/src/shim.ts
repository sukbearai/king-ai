import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SHIM = `#!/usr/bin/env node
'use strict'
;(async () => {
  const commandName = require('path').basename(process.argv[1] || process.argv[0] || 'king')
  const url = process.env.KING_AGENT_RUNTIME_URL
  let token = process.env.KING_AGENT_RUNTIME_TOKEN
  const tenant = process.env.KING_AGENT_RUNTIME_TENANT
  const tokenFile = process.env.KING_AGENT_RUNTIME_TOKEN_FILE
  if (tokenFile) {
    try {
      const fresh = require('fs').readFileSync(tokenFile, 'utf8').trim()
      if (fresh) token = fresh
    } catch {}
  }
  if (!url || !token) {
    console.error(commandName + ': runtime env not set')
    process.exit(70)
  }
  const fs = require('fs')
  const argv = process.argv.slice(2)
  const fileIdx = argv.indexOf('--file')
  if (fileIdx >= 0 && argv[fileIdx + 1] !== undefined) {
    try {
      argv.splice(fileIdx, 2, fs.readFileSync(argv[fileIdx + 1], 'utf8'))
    } catch {
      console.error(commandName + ': cannot read --file ' + argv[fileIdx + 1])
      process.exit(70)
    }
  }
  const stdinIdx = argv.indexOf('--stdin')
  if (stdinIdx >= 0) {
    let body = ''
    try { body = fs.readFileSync(0, 'utf8') } catch {}
    argv.splice(stdinIdx, 1, body)
  }
  const res = await fetch(url + '/cli', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(tenant ? { 'X-King-Tenant': tenant } : {}) },
    body: JSON.stringify({ argv, agentId: process.env.KING_AGENT_ID || undefined, engine: process.env.KING_AGENT_ENGINE || undefined })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(commandName + ': HTTP ' + res.status + ' ' + text)
    process.exit(70)
  }
  const data = await res.json()
  if (typeof data.text === 'string' && data.text) process.stdout.write(data.text + '\\n')
  process.exit(typeof data.exitCode === 'number' ? data.exitCode : 0)
})().catch((err) => {
  const commandName = require('path').basename(process.argv[1] || process.argv[0] || 'king')
  console.error(commandName + ':', err && err.message ? err.message : err)
  process.exit(70)
})
`;

export async function writeShim(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  for (const name of ["king"]) {
    const shim = join(binDir, name);
    await writeFile(shim, SHIM, "utf8");
    await chmod(shim, 0o755);
  }
}
