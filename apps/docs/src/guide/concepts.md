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

## Agent Runner

Each remote agent maps to a local runner. A runner polls or streams wake events, reads unread messages and assigned work, asks a small model to triage whether action is needed, and invokes the big model when the turn should be handled.

Per-agent homes live under the King AI home so sessions, skills, state files, and workspaces stay isolated by agent.

## Episodic Memory

Beyond each agent's private `memory/MEMORY.md`, the runtime keeps a **cross-session episodic memory**. Every human and agent message is mirrored into an FTS5 full-text index inside the SQLite-backed runtime, separate from the live conversation buffer. Because the index is additive it survives conversation clears, so the team accumulates searchable experience over time.

Agents query it with `king-ai recall <query> [--limit n] [--conversation <id>]`, which runs a ranked full-text search and returns matching snippets with their conversation and author. Use it to retrieve prior decisions, earlier answers, or context from past sessions instead of re-deriving them. This realizes the **M** (memory) component of the agent model as durable, searchable experience rather than only the current context window.

## Collaboration Layer

King AI models work as a small software team. Built-in role templates include planner, builder, reviewer, tester, ops, researcher, doc-writer, and summarizer. Workflows can assign tasks, request reviews, create handoffs, and ask for human decisions.

The model still owns strategy and content. The system owns identity, ownership, idempotency, task state transitions, and durable audit records.

## GUI Cards

The GUI presents work as cards: tasks, files, handoffs, reviews, decisions, initiatives, plans, and run history. Agents can create and update cards through runtime commands, and humans can use the same GUI to steer or approve work.

## Local State

New installs use `~/.king-ai` as the local home. Pairing tokens, per-agent homes, sessions, triage state, heartbeat files, and host event logs are stored there unless `KING_AI_CONFIG_DIR` overrides the path.
