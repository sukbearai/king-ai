---
layout: home

hero:
  name: King AI
  text: Local BYOA agents for team collaboration
  tagline: Pair your machine, run local Claude or Codex agents, and coordinate work through the GUI runtime.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: CLI Reference
      link: /guide/cli

features:
  - title: Pair a local computer
    details: Attach this machine to a runtime server once, then reuse the same local daemon for future agent work.
  - title: Use your own engines
    details: King AI drives installed Claude Code or Codex CLIs instead of proxying model credentials through the server.
  - title: Coordinate a team
    details: Built-in roles, task cards, reviews, handoffs, and decision gates keep multi-agent work accountable.
  - title: Keep state local
    details: Pairing, sessions, agent homes, and runtime state live under the King AI home on this machine.
---

## Quick Path

Check your local engines:

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --doctor
```

Pair this computer from the GUI, then start the local daemon:

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --pair 'king-ai://pair?...'
pnpm dlx @suwujs/king-ai@latest agent computer
```

Developing this repository:

```sh
pnpm install
pnpm verify
pnpm docs:dev
```
