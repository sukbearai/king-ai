---
name: codex-first
description: "Claude Code-only workflow for delegating scoped implementation, bug fixes, tests, CI, or bulk exploration to Codex CLI while Claude owns specification, review, and verification. Skip in Codex and other harnesses; never self-delegate."
---

# Codex First

## Session Gate

Apply this gate before running any CLI command:

- Claude Code session: continue.
- Codex or any other harness: stop applying this skill. Never invoke `codex exec` from a Codex session.

Explicitly naming `$codex-first` does not override the gate. This skill moves hands-on work to Codex CLI while Claude keeps design, specification, review, and verification.

## Route

Delegate to Codex (default for hands-on work):

- implementation from a frozen spec; refactors; mechanical migrations
- bug fixes with known repro; test writing; coverage fills
- CI fixes, dependency bumps, scripts/tooling
- bulk codebase exploration where raw reading >> the answer

Keep in Claude:

- design, API design, architecture, naming, UX judgment
- tasks where writing the spec IS the work (ambiguity = design)
- tiny edits (~<20 lines, single obvious change) - delegation overhead loses
- anything needing session tools: MCP (browser/computer-use/chronicle), 1Password, secrets
- destructive/irreversible ops, releases, pushes, GitHub mutations - Claude-side per git rules
- review of Codex output - never delegated, never skipped

Mixed task: Claude designs first, freezes spec, delegates build-out.
Heuristic: prompt reads as a work order -> delegate; writing it forces decisions -> design, Claude.
Portfolio/multi-repo work: `$maintainer-orchestrator` instead.

Do not call Codex merely to produce a plan that Claude can write in the current session. Freeze the spec in Claude first, then delegate implementation.

## Invoke

Prompt via a temp file, never inline quoting:

```bash
P=$(mktemp); cat >"$P" <<'EOF'
<goal, repo + key paths, constraints ("don't touch X"), non-goals, proof expected, output shape>
EOF
command codex exec --yolo -C <repo> \
  -c model_reasoning_effort="high" \
  -o /tmp/codex-last.md - <"$P" 2>/dev/null
```

- `--yolo` is the house default; Codex may run commands/tests freely. Keep prompts scoped to the target repo.
- `command codex` bypasses the interactive zsh wrapper; if not on PATH: `fnm exec --using default -- codex`
- stderr suppressed (thinking noise bloats context); drop `2>/dev/null` only to debug a failing run
- read `-o` file for the result; don't parse the JSONL stream
- long runs: Bash run_in_background, read `-o` file on exit; don't kill quiet runs <30 min
- parallel independent tasks OK: separate repos/dirs, separate `-o` files
- outside a git repo add `--skip-git-repo-check`

Follow-up fixes - cheaper than fresh runs, keeps context. `resume` has no `-C`/`--yolo`: run from the repo dir, spell the long flag:

```bash
(cd <repo> && command codex exec resume --last \
  --dangerously-bypass-approvals-and-sandbox \
  -o /tmp/codex-last.md - <"$P2" 2>/dev/null)
```

## Prompt Contract

The external Codex process starts with zero Claude session context. Every prompt must include the goal, exact repo and paths, constraints, non-goals, expected proof, and output shape. Include relevant source facts; do not assume Codex can see chat history, screenshots, secrets, or Claude-only tools.

## Verify (Claude, always)

- `git status -sb` + read the full diff; judge like a contributor PR
- run focused tests yourself or demand proof output; Codex claims are advisory
- iterate via resume; after 2 failed rounds, take over and do it directly
- normal closeout still applies: `$autoreview` before ship

## Economics

Win = generation + exploration tokens moved to Codex; Claude spends only on spec + diff review. Don't ping-pong trivia through delegation; don't re-read what Codex already summarized.
