# Core Concepts

## Design Paradigm: Agentic Engineering

King AI is built on the **Agentic Engineering** paradigm: with a large language model as the primary reasoning engine, source code stops being *the system* and becomes an ephemeral instrument the model generates and discards inside a reasoning loop. Delivery shifts from `intent → software → result` to `intent → agent → result` — a human states goals and constraints, agents plan, execute, validate, and deliver an outcome, and the human audits that outcome. This framing follows Cao, *The End of Software Engineering* ([arXiv:2606.05608](https://arxiv.org/abs/2606.05608)).

In that model an agent system is the tuple **A = (M, T, M, Π)**, and King AI maps onto it directly:

| Concept | In King AI |
| --- | --- |
| **M** — reasoning engine | Local Claude Code / Codex CLI as the big model, with a small model for inbox triage |
| **T** — executable tools | The `king-ai` runtime CLI (`reply`, `task`, `card`, `doc`, `recall`…), the host SDK, and remote-diagnostics commands |
| **M** — memory | Per-agent durable memory (`memory/MEMORY.md`) plus cross-session [episodic recall](#episodic-memory) |
| **Π** — planning | Inbox triage, task routing, auto-delegation, and a coordinator agent decomposing intent into assigned work |

The human role is reframed as **intent architect, coordinator, and outcome auditor** rather than code author: you state what you want, shape how the team coordinates, and approve results at the decision gates the [Collaboration Layer](#collaboration-layer) enforces.

## Runtime Boundary

King AI has two sides:

- The remote runtime server owns pairing, browser-facing state, wake events, message queues, cards, tasks, decisions, and status snapshots.
- The local computer daemon owns local execution. It calls installed Claude Code or Codex CLIs, writes local runtime state, and runs agent work inside allowed local workspaces.

This keeps model credentials and engine sessions local while still giving the GUI a shared collaboration ledger.

## How the GUI and Daemon Communicate

The browser GUI and the local daemon **never connect to each other directly**. They rendezvous through the remote runtime — a Cloudflare Worker (a Hono app) backed by one **`GuiState` Durable Object per tenant**, which is the single durable ledger of conversations, messages, tasks, cards, the agent registry, and status. Three clients all speak HTTPS to the same Worker:

| Client | Talks to | For |
| --- | --- | --- |
| Browser GUI | `/gui/*` | read state, create conversations, post human messages |
| Local daemon (`king-ai agent computer`) | `/api/*`, `/runtime/*` | pair, mint tokens, receive wakes, post replies/status/events/runs |
| Local agents (Claude / Codex) | `/runtime/cli` via the PATH shim | every `king-ai <cmd>` an agent runs |

**Crossing NAT without opening a port.** The local machine is never a server — it always dials out. On start, each agent runner opens a long-lived **Server-Sent Events** stream to `GET /runtime/wake-stream` and keeps it open. The Durable Object holds that connection's writer in memory (`waiters`), so it can push down the stream at any moment. This is how the cloud reaches a laptop behind NAT or a firewall.

A human message travels end to end like this:

```text
Browser ──POST /gui/message──▶ Worker ──▶ GuiState DO
                                            │ append message, persist
                                            │ broadcast { event: "wake", conversationId, messageId, agentId }
                                            ▼
                            wake frame ──▶ daemon's open /runtime/wake-stream (SSE)
                                            ▼
                  AgentRunner: GET /runtime/inbox → small-model triage → local Claude/Codex turn
                                            ▼
                  POST /runtime/cli { argv: ["reply", convId, text] } ──▶ DO append reply, persist
                                            ▼
Browser ◀──GET /gui/state──── Worker ◀────── DO (now shows the reply)
```

**Identity and isolation.** Pairing redeems a one-time code (`POST /api/computers/pair`) for a long-lived device token saved under `~/.king-ai`. From it the daemon mints short-lived per-agent runtime tokens (`POST /api/agents/<id>/runtime-token`) that authorize `/runtime/*` calls. Every request is routed to `GUI_STATE.idFromName(tenantId)`, so each tenant gets an isolated Durable Object — its own messages, agents, and state.

**What stays local.** Model credentials and engine sessions never leave the machine. The Worker only ever sees runtime messages and state transitions; the actual Claude/Codex processes, their sessions, and your workspaces live entirely on your computer.

## Agent Runner

Each remote agent maps to a local runner. A runner polls or streams wake events, reads unread messages and assigned work, asks a small model to triage whether action is needed, and invokes the big model when the turn should be handled.

Per-agent homes live under the King AI home so sessions, skills, state files, and workspaces stay isolated by agent.

## Episodic Memory

Beyond each agent's private `memory/MEMORY.md`, the runtime keeps a **cross-session episodic memory**. Every human and agent message is mirrored into an FTS5 full-text index inside the SQLite-backed runtime, separate from the live conversation buffer. Because the index is additive it survives conversation clears, so the team accumulates searchable experience over time.

Agents query it with `king-ai recall <query> [--limit n] [--conversation <id>]`, which runs a ranked full-text search and returns matching snippets with their conversation and author. Use it to retrieve prior decisions, earlier answers, or context from past sessions instead of re-deriving them. This realizes the **M** (memory) component of the agent model as durable, searchable experience rather than only the current context window.

## Skill Self-Evolution

Agents can turn a procedure that worked into a reusable **skill** for future sessions with `king-ai skill save <name> --file notes/skill.md` (plus `skill list`, `show`, and `remove`). Learned skills are stored outside the ephemeral agent home, so they survive restarts and resets, and the daemon reinstalls them into `.claude/skills` and `.codex/skills` on every start — a closed learning loop where the team's procedural knowledge compounds over time. Saves are validated (slugged name, size and count caps) and kept per-agent. This realizes the paradigm's notion of self-improving skills as durable, reusable modules rather than throwaway context.

## Collaboration Layer

King AI models work as a small team. **Role templates** are a small, domain-neutral vocabulary for *how* an agent participates in a workflow — its coordination behavior plus the capabilities and permissions that come with it. The built-in templates are `planner`, `builder`, `reviewer`, `tester`, `ops`, `researcher`, `doc-writer`, and `summarizer`. Workflows use them to route work by capability, request reviews, create handoffs, and ask for human decisions.

A template is not an agent. A concrete roster maps agents onto templates and may **fold one template into another** instead of staffing it one-to-one — for example the default team has no standalone summarizer; the planner (King AI CEO) owns that loop-closing responsibility. Domain agents work the same way: the IELTS coach is a single-agent workflow that reuses the generic `builder` template for coordination (it does the work directly), while its subject expertise lives in its free-text role, not in a new template. This keeps the template set generic and reusable across domains — *what* an agent knows belongs to its role and its **workflow template**, not to the coordination vocabulary.

In the IELTS Study workflow, the coach annotates English inline: each sentence gets one `[core: ...]` mark for a short, word-for-word continuous subject/verb substring from the sentence, and `[phrase: ...]` marks only useful short phrases. The coach should highlight text that already appears in the sentence, not add a separate compressed restatement. Its hidden Glossary line supplies Chinese meanings, phonetics, syllable splits for content words, and Chinese meanings for highlighted phrases so word and phrase cards stay useful without cluttering the reply.

The model still owns strategy and content. The system owns identity, ownership, idempotency, task state transitions, and durable audit records.

## GUI Cards

The GUI presents work as cards: tasks, files, handoffs, reviews, decisions, initiatives, plans, and run history. Agents can create and update cards through runtime commands, and humans can use the same GUI to steer or approve work.

## Local State

New installs use `~/.king-ai` as the local home. Pairing tokens, per-agent homes, sessions, triage state, heartbeat files, and host event logs are stored there unless `KING_AI_CONFIG_DIR` overrides the path.
