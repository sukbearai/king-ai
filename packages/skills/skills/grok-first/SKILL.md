---
name: grok-first
description: "Route implementation work to Grok CLI headless mode; Claude specs, reviews, verifies."
---

# Grok First

Claude Code sessions only. Grok/other harnesses: skip; never self-delegate.

Rationale: Grok CLI has a headless mode suitable for scripted prompts, repo-local work, implementation, exploration, and alternate-model review. Claude keeps ergonomics, judgment, design, spec-writing, review, and orchestration. So Grok types, Claude thinks and verifies.

## Route

Delegate to Grok (default for hands-on work):

- implementation from a frozen spec; refactors; mechanical migrations
- bug fixes with known repro; test writing; coverage fills
- CI fixes, dependency bumps, scripts/tooling
- bulk codebase exploration where raw reading >> the answer
- second-opinion debugging, review, or risk analysis when Grok is the desired alternate model

Keep in Claude:

- design, API design, architecture, naming, UX judgment
- tasks where writing the spec IS the work (ambiguity = design)
- tiny edits (~<20 lines, single obvious change) - delegation overhead loses
- anything needing session tools: MCP (browser/computer-use/chronicle), 1Password, secrets
- destructive/irreversible ops, releases, pushes, GitHub mutations - Claude-side per git rules
- review of Grok output - never delegated, never skipped

Mixed task: Claude designs first, freezes spec, delegates build-out.
Heuristic: prompt reads as a work order -> delegate; writing it forces decisions -> design, Claude.
Portfolio/multi-repo work: `$maintainer-orchestrator` instead.

## Invoke

Prompt via a temp file, not inline quoting. Use Grok headless mode with an explicit working directory and saved output:

```bash
P=$(mktemp); cat >"$P" <<'EOF'
<goal, repo + key paths, constraints ("don't touch X"), non-goals, proof expected, output shape>
EOF
command grok -p "$(cat "$P")" \
  --cwd <repo> \
  --model grok-4.5 \
  --output-format plain \
  --always-approve \
  --no-alt-screen \
  > /tmp/grok-last.md
```

- `-p` / `--single` sends one prompt.
- `--cwd <PATH>` sets the working directory; keep prompts scoped to the target repo.
- `--model <MODEL>` chooses the model. Omit it if the default model is intentional.
- `--output-format plain` is easiest for human review; use `json` or `streaming-json` only for machine parsing.
- `--always-approve` auto-approves tool executions. Use it only for scoped, non-destructive repo work.
- `--no-alt-screen` keeps Grok inline instead of taking over a fullscreen terminal.
- `command grok` bypasses shell aliases/functions. If Grok is not on `PATH`, fix the local CLI installation before delegating.
- Read `/tmp/grok-last.md` for the result.
- For long runs, use a background shell job and read the output file on exit. Do not kill quiet runs under 30 minutes.
- Parallel independent tasks are allowed with separate repos or directories and separate output files.

## Follow-up fixes

Cheaper than fresh runs, keeps context. Prefer `--continue` for the most recent Grok session in the current directory, or `--resume <ID>` when a specific Grok session should be resumed. Grok headless sessions are stored under `~/.grok/sessions`.

```bash
P2=$(mktemp); cat >"$P2" <<'EOF'
<focused correction request, exact files, failing proof, expected output>
EOF
command grok -p "$(cat "$P2")" \
  --cwd <repo> \
  --continue \
  --output-format plain \
  --always-approve \
  --no-alt-screen \
  > /tmp/grok-last.md
```

## Prompt Contract

Grok starts with zero Claude session context. Every prompt: goal, exact repo/paths, constraints ("don't touch X"), non-goals, proof expected (exact test command), output shape ("report files changed + test output"). Spec quality decides success.

Include the relevant source facts in the prompt. Do not assume Grok can see the screenshot, chat history, secrets, MCP state, or Claude-only reasoning.

## Verify (Claude, always)

- `git status -sb` + read the full diff; judge like a contributor PR
- run focused tests yourself or demand proof output; Grok claims are advisory
- compare Grok's answer against live repo state before acting on it
- iterate via `--continue` or `--resume`; after 2 failed rounds, take over and do it directly
- normal closeout still applies: `$autoreview` before ship

## Economics

Win = exploration, alternate-model review, and draft implementation moved to Grok while Claude spends only on spec + diff review. Don't ping-pong trivia through delegation; don't re-read what Grok already summarized unless verification requires it.
