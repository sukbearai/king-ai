---
name: codex-grok
description: "Route non-trivial implementation work through a two-step CLI workflow: Codex produces a frozen plan/spec, then Grok CLI executes it in headless mode while the coordinator reviews and verifies. Use when a task is too ambiguous to hand straight to Grok, but the implementation should still be delegated to Grok after Codex planning."
---

# Codex Grok

Coordinator sessions only. Grok sessions: skip; never self-delegate. Codex sessions: use this only if a separate Grok execution pass is valuable; do not spawn a redundant Codex planner for your own planning.

Rationale: this is a `grok-first` derivative for tasks where the missing piece is not raw implementation capacity, but a frozen implementation plan. Codex does the read-only planning/spec pass; Grok types from that spec; the coordinator verifies the diff and tests.

## Route

Use Codex -> Grok when:

- implementation is non-trivial and needs an explicit plan before edits
- the request has known boundaries, but the exact file-level execution path is not frozen
- a refactor, bug fix, test-fill, CI fix, or migration would benefit from a separate design/spec pass
- Grok should execute, but should not invent architecture or broaden scope
- you want Codex's repo analysis before using Grok as the implementer

Use plain `$grok-first` instead when the spec is already frozen and Grok can start coding immediately.

Keep in the coordinator:

- deciding whether the Codex plan is acceptable
- final design/API/UX judgment when Codex surfaces tradeoffs
- anything needing session-only tools: MCP, browser/computer-use, 1Password, secrets
- destructive/irreversible operations, releases, pushes, GitHub mutations
- review of Grok output; never delegated, never skipped

Tiny edits (~<20 lines, single obvious change) should usually be done directly. Portfolio/multi-repo work still belongs to `$maintainer-orchestrator`.

## Invoke Codex Planner

Prompt via a temp file. Codex planning is read-only: it may inspect the repo and run safe read-only commands, but it must not edit files.

```bash
P=$(mktemp); PLAN=/tmp/codex-plan.md; cat >"$P" <<'EOF'
You are the planning pass only. Do not edit files.

Goal:
<user goal>

Repo:
<absolute repo path>

Known constraints:
<paths to avoid, compatibility rules, non-goals, docs/test expectations>

Produce a frozen execution spec for Grok with:
1. Problem framing and assumptions
2. Files/modules to inspect or change
3. Exact implementation steps
4. Tests/verification commands Grok should run
5. Risks and out-of-scope items
EOF
command codex exec -C <repo> \
  --sandbox read-only \
  -c model_reasoning_effort="high" \
  -o "$PLAN" - <"$P" 2>/dev/null
```

- Read `$PLAN` before continuing.
- Reject or edit the plan if it broadens scope, depends on hidden context, or leaves key choices unresolved.
- If the plan is still a design discussion rather than an execution spec, run one focused Codex follow-up or take over planning directly.
- Do not hand Grok unresolved alternatives unless choosing among them is explicitly part of the task.

## Invoke Grok Executor

Use Grok headless mode from the accepted Codex plan. Prefer `--prompt-file` so the prompt can embed the plan without shell quoting risk.

```bash
GP=$(mktemp); cat >"$GP" <<'EOF'
Execute the frozen implementation spec below. Do not redesign it or broaden scope.

Repo:
<absolute repo path>

Coordinator constraints:
<paths to avoid, non-goals, exact verification expected>

Frozen Codex plan:
<paste /tmp/codex-plan.md>

Output shape:
- files changed
- commands run and their results
- any deviations from the plan, with reason
EOF
command grok --prompt-file "$GP" \
  --cwd <repo> \
  --model grok-4.5 \
  --output-format plain \
  --always-approve \
  --no-alt-screen \
  > /tmp/grok-last.md
```

- `--cwd <PATH>` sets the working directory; keep prompts scoped to the target repo.
- `--model <MODEL>` chooses the model. Omit it if the default model is intentional.
- `--output-format plain` is easiest for human review; use `json` or `streaming-json` only for machine parsing.
- `--always-approve` auto-approves tool executions. Use it only for scoped, non-destructive repo work.
- Read `/tmp/grok-last.md` for the result.
- For long runs, use a background shell job and read the output file on exit. Do not kill quiet runs under 30 minutes.

## Follow-up Fixes

Use the same split:

- If the failure is a bad or incomplete plan, resume Codex or patch the plan yourself before asking Grok to continue.
- If the plan is sound but execution is wrong, continue Grok with the failing proof and the narrow correction.

```bash
P2=$(mktemp); cat >"$P2" <<'EOF'
The previous implementation diverged from the frozen plan or failed verification.

Fix only:
<specific correction>

Failure proof:
<test output, diff concern, or exact reviewer finding>

Expected verification:
<commands>
EOF
command grok --prompt-file "$P2" \
  --cwd <repo> \
  --continue \
  --output-format plain \
  --always-approve \
  --no-alt-screen \
  > /tmp/grok-last.md
```

After two failed execution rounds, stop delegating and take over directly.

## Prompt Contract

Both external agents start with zero coordinator session context.

Codex planner prompt must include: goal, repo, relevant paths, constraints, non-goals, required output shape, and proof expected.

Grok executor prompt must include: accepted Codex plan, repo, explicit "do not redesign" instruction, constraints, exact verification commands, and output shape.

Do not assume either agent can see screenshots, chat history, secrets, MCP state, or coordinator-only reasoning. Paste the relevant facts.

## Verify (Coordinator, Always)

- `git status -sb` + read the full diff; judge like a contributor PR
- compare Grok's changes against the accepted Codex plan
- run focused tests yourself or demand proof output; Grok claims are advisory
- verify docs updates if behavior, commands, configuration, or runtime architecture changed
- normal closeout still applies: `$autoreview` before ship

## Economics

Win = Codex spends cheap planning/exploration tokens, Grok spends implementation tokens, and the coordinator spends attention only on plan acceptance and diff verification. If the task is already clear enough for Grok, use `$grok-first`; if the task is mostly design, keep it in the coordinator.
