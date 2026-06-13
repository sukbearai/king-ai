# Getting Started

King AI connects a remote runtime server to local agent engines on your machine. Pair once, keep Claude Code, Codex, or Grok signed in locally, then run the computer daemon whenever you want agents to work.

## Prerequisites

- Node.js 20 or newer.
- `pnpm` for development commands and one-off `dlx` runs.
- At least one supported local engine installed and authenticated: `claude`, `codex`, or `grok`.
- Access to the King AI GUI at `https://king-ai.congrongtech.cn`.

## Check Local Engines

Run the doctor before pairing. It checks PATH, engine availability, and whether the local engines can serve both big-brain and small-brain requests.

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --doctor
```

For source checkout development:

```sh
pnpm install
pnpm dev -- agent computer --doctor
```

## Pair This Computer

Open the GUI, copy the first-time pairing command, and run it on the machine that will host local agents. New pairing links use the `king-ai://pair?...` format and include the server and tenant information when needed.

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --pair 'king-ai://pair?...'
```

If the GUI gives you only a short code, use the production default:

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --pair <code>
```

Use `--server <url>` only for local development or a separate deployment.

The CLI writes the pairing config to `~/.king-ai/computer.json` and keeps token-bearing files in the King AI home on this machine.

## Start The Daemon

After pairing, start the daemon in the foreground:

```sh
pnpm dlx @suwujs/king-ai@latest agent computer
```

Useful service commands:

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --install-service
pnpm dlx @suwujs/king-ai@latest agent computer --status
pnpm dlx @suwujs/king-ai@latest agent computer --logs
```

## Develop From This Repository

Run the source CLI through the root dev script:

```sh
pnpm dev -- agent computer --pair <code> --server http://127.0.0.1:8787
pnpm dev -- agent computer --server http://127.0.0.1:8787
```

Run the documentation site locally:

```sh
pnpm docs:dev
```
