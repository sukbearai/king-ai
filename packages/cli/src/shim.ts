import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SHIM = `#!/usr/bin/env node
'use strict'
;(async () => {
  const commandName = require('path').basename(process.argv[1] || process.argv[0] || 'king-ai')
  const fs = require('fs')
  const path = require('path')
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
  // Learned-skill self-evolution: persisted locally outside the ephemeral agent home so skills
  // survive restarts/resets and are reinstalled next session. Handled before the runtime check
  // because it never touches the remote runtime.
  if (argv[0] === 'skill') {
    const learnedDir = process.env.KING_AI_AGENT_LEARNED_SKILLS
    const fail = (m) => { console.error(commandName + ': ' + m); process.exit(64) }
    if (!learnedDir) fail('learned skills dir not configured')
    const slug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,48}$/.test(s)
    const maxSkills = Number(process.env.KING_AI_LEARNED_SKILLS_MAX || 24)
    const maxBytes = 16384
    const listNames = () => {
      try {
        return fs.readdirSync(learnedDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && fs.existsSync(path.join(learnedDir, e.name, 'SKILL.md')))
          .map((e) => e.name)
      } catch { return [] }
    }
    const sub = argv[1]
    if (sub === 'list') { process.stdout.write(listNames().join('\\n') + '\\n'); process.exit(0) }
    if (sub === 'show') {
      const name = argv[2]
      if (!slug(name)) fail('usage: king-ai skill show <name>')
      try { process.stdout.write(fs.readFileSync(path.join(learnedDir, name, 'SKILL.md'), 'utf8')) }
      catch { fail('no such learned skill: ' + name) }
      process.exit(0)
    }
    if (sub === 'remove' || sub === 'delete') {
      const name = argv[2]
      if (!slug(name)) fail('usage: king-ai skill remove <name>')
      try { fs.rmSync(path.join(learnedDir, name), { recursive: true, force: true }) } catch {}
      process.stdout.write('removed learned skill ' + name + '\\n'); process.exit(0)
    }
    if (sub === 'save') {
      const name = argv[2]
      const content = (argv[3] || '').toString()
      if (!slug(name)) fail('skill name must be a slug [a-z0-9-] up to 49 chars')
      if (!content.trim()) fail('skill content is empty (use --file <draft.md> or --stdin)')
      if (Buffer.byteLength(content, 'utf8') > maxBytes) fail('skill too large (max ' + maxBytes + ' bytes)')
      const names = listNames()
      if (!names.includes(name) && names.length >= maxSkills) fail('learned skill limit reached (' + maxSkills + '); remove one first')
      const dest = path.join(learnedDir, name)
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, 'SKILL.md'), content, 'utf8')
      process.stdout.write('saved learned skill ' + name + ' (available next session)\\n'); process.exit(0)
    }
    fail('usage: king-ai skill save|list|show|remove <name> [--file <draft.md>]')
  }
  const url = process.env.KING_AI_AGENT_RUNTIME_URL
  let token = process.env.KING_AI_AGENT_RUNTIME_TOKEN
  const tenant = process.env.KING_AI_AGENT_RUNTIME_TENANT
  const tokenFile = process.env.KING_AI_AGENT_RUNTIME_TOKEN_FILE
  if (tokenFile) {
    try {
      const fresh = fs.readFileSync(tokenFile, 'utf8').trim()
      if (fresh) token = fresh
    } catch {}
  }
  if (!url || !token) {
    console.error(commandName + ': runtime env not set')
    process.exit(70)
  }
  let contract
  if (process.env.KING_AI_AGENT_RUNTIME_CONTRACT) {
    try { contract = JSON.parse(process.env.KING_AI_AGENT_RUNTIME_CONTRACT) } catch {}
  }
  const res = await fetch(url + '/cli', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(tenant ? { 'X-King-AI-Tenant': tenant } : {}) },
    body: JSON.stringify({
      argv,
      agentId: process.env.KING_AI_AGENT_ID || undefined,
      engine: process.env.KING_AI_AGENT_ENGINE || undefined,
      runId: process.env.KING_AI_AGENT_RUNTIME_RUN_ID || undefined,
      contract
    })
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
  const commandName = require('path').basename(process.argv[1] || process.argv[0] || 'king-ai')
  console.error(commandName + ':', err && err.message ? err.message : err)
  process.exit(70)
})
`;

export async function writeShim(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  for (const name of ["king-ai"]) {
    const shim = join(binDir, name);
    await writeFile(shim, SHIM, "utf8");
    await chmod(shim, 0o755);
  }
}
