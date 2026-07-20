import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  claudeStreamUserMessage,
  createGrokLogSink,
  ENGINE_PREFERENCE_ORDER,
  formatEngineLogLine,
  getAdapter,
  grokTurnFromStdout,
  parseTriage,
  personaHeader,
  reduceCodexAppEvent,
  splitExtraArgs,
} from "../src/engine.js";
import { writeShim } from "../src/shim.js";
import { authFailureHint, hashText, isRateLimited } from "../src/text.js";

const execFileP = promisify(execFile);

function runWithStdin(bin: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `process exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

test("parseTriage accepts raw JSON", () => {
  assert.deepEqual(parseTriage('{"actionable":false,"reason":"noise"}'), {
    actionable: false,
    reason: "noise",
    promptNote: undefined,
    responseMode: undefined,
  });
});

test("parseTriage extracts JSON from model prose", () => {
  assert.deepEqual(parseTriage('Verdict:\n{"actionable":true,"promptNote":"reply briefly"}'), {
    actionable: true,
    reason: undefined,
    promptNote: "reply briefly",
    responseMode: undefined,
  });
});

test("parseTriage rejects missing actionable", () => {
  assert.equal(parseTriage('{"reason":"missing"}'), null);
});

test("parseTriage accepts fenced JSON and response_mode", () => {
  assert.deepEqual(
    parseTriage('```json\n{"actionable":true,"response_mode":"one-of-us","prompt_note":"claim first"}\n```'),
    {
      actionable: true,
      reason: undefined,
      promptNote: "claim first",
      responseMode: "one-of-us",
    },
  );
});

test("parseTriage salvages partial JSON", () => {
  assert.deepEqual(parseTriage('{"actionable":false,"reason":"already handled","responseMode":"me"'), {
    actionable: false,
    reason: "already handled",
    promptNote: undefined,
    responseMode: "me",
  });
});

test("formatEngineLogLine summarizes Claude stream JSON", () => {
  assert.equal(formatEngineLogLine("claude", '{"type":"system","subtype":"init"}'), "[claude] session initialized");
  assert.equal(
    formatEngineLogLine("claude", '{"type":"assistant","message":{"content":[{"type":"text","text":"hello there"}]}}'),
    "[claude] hello there",
  );
  assert.equal(formatEngineLogLine("claude", '{"type":"result","is_error":false}'), "[claude] turn completed");
});

test("formatEngineLogLine summarizes Claude tool_use blocks", () => {
  assert.equal(
    formatEngineLogLine(
      "claude",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
        },
      }),
    ),
    "[claude] $ ls -la",
  );
  assert.equal(
    formatEngineLogLine(
      "claude",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { path: "/tmp/notes.md" } }],
        },
      }),
    ),
    '[claude] -> Read {"path":"/tmp/notes.md"}',
  );
  assert.equal(
    formatEngineLogLine(
      "claude",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "running a check" },
            { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
          ],
        },
      }),
    ),
    "[claude] running a check\n[claude] $ pnpm test",
  );
  const longInput = { query: "x".repeat(200) };
  const longLine = formatEngineLogLine(
    "claude",
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Search", input: longInput }] },
    }),
  );
  assert.ok(longLine?.startsWith("[claude] -> Search "));
  assert.ok((longLine?.length ?? 0) <= "[claude] -> Search ".length + 120);
});

test("claudeStreamUserMessage strips malformed surrogate characters", () => {
  const encoded = claudeStreamUserMessage("hello \uD800 world");
  assert.equal(encoded.endsWith("\n"), true);
  const parsed = JSON.parse(encoded) as {
    type: string;
    message: { role: string; content: Array<{ type: string; text: string }> };
  };
  assert.equal(parsed.type, "user");
  assert.equal(parsed.message.role, "user");
  assert.deepEqual(parsed.message.content, [{ type: "text", text: "hello  world" }]);
});

test("formatEngineLogLine drops noisy engine JSON", () => {
  assert.equal(
    formatEngineLogLine("claude", '{"type":"assistant","message":{"content":[{"type":"thinking","text":"hidden"}]}}'),
    null,
  );
  assert.equal(formatEngineLogLine("codex", '{"method":"thread/started","params":{"thread":{"id":"t1"}}}'), null);
});

test("formatEngineLogLine summarizes Grok streaming JSON", () => {
  assert.equal(formatEngineLogLine("grok", '{"type":"text","data":"hello there"}'), "[grok] hello there");
  assert.equal(formatEngineLogLine("grok", '{"type":"end","stopReason":"EndTurn"}'), "[grok] turn completed");
  assert.equal(
    formatEngineLogLine("grok", '{"type":"error","message":"Session does not exist"}'),
    "[grok] failed: Session does not exist",
  );
  assert.equal(formatEngineLogLine("grok", '{"type":"thought","data":"hidden"}'), null);
});

test("createGrokLogSink buffers streaming text deltas into one line", () => {
  const lines: string[] = [];
  const sink = createGrokLogSink((line) => lines.push(line));
  sink('{"type":"text","data":"hello"}');
  sink('{"type":"text","data":" there"}');
  assert.deepEqual(lines, []);
  sink('{"type":"end","stopReason":"EndTurn"}');
  assert.deepEqual(lines, ["[grok] hello there", "[grok] turn completed"]);
});

test("createGrokLogSink buffers thought deltas before subsequent text", () => {
  const lines: string[] = [];
  const sink = createGrokLogSink((line) => lines.push(line));
  sink('{"type":"thought","data":"plan "}');
  sink('{"type":"thought","data":"reply"}');
  assert.deepEqual(lines, []);
  sink('{"type":"text","data":"Hello."}');
  assert.deepEqual(lines, ["[grok] (thinking) plan reply"]);
  sink('{"type":"end","stopReason":"EndTurn"}');
  assert.deepEqual(lines, ["[grok] (thinking) plan reply", "[grok] Hello.", "[grok] turn completed"]);
});

test("grokTurnFromStdout extracts structuredOutput usage and model from streaming end event", () => {
  const stdout = [
    '{"type":"thought","data":"thinking"}',
    '{"type":"text","data":"hi"}',
    JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "sess-stream-1",
      usage: { input_tokens: 124, output_tokens: 10, reasoning_tokens: 5 },
      modelUsage: { "grok-4.5-build-free": { inputTokens: 124 } },
      structuredOutput: { ok: true, replyMarkdown: "hi" },
    }),
  ].join("\n");
  const result = grokTurnFromStdout(stdout, "fallback-model");
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "sess-stream-1");
  assert.deepEqual(result.structuredOutput, { ok: true, replyMarkdown: "hi" });
  assert.deepEqual(result.usage, { input_tokens: 124, cache_read_input_tokens: 0, output_tokens: 15 });
  assert.equal(result.model, "grok-4.5-build-free");
});

test("ENGINE_PREFERENCE_ORDER prefers grok before claude and codex", () => {
  assert.deepEqual(ENGINE_PREFERENCE_ORDER, ["grok", "claude", "codex"]);
});

test("formatEngineLogLine summarizes Codex app-server events", () => {
  assert.equal(
    formatEngineLogLine(
      "codex",
      '{"method":"item/started","params":{"item":{"type":"commandExecution","command":"king-ai reply demo hi"}}}',
    ),
    "[codex] $ king-ai reply demo hi",
  );
  assert.equal(
    formatEngineLogLine("codex", '{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"done"}}}'),
    "[codex] done",
  );
});

test("formatEngineLogLine can keep raw Codex app-server events", () => {
  const raw = '{"method":"thread/started","params":{"thread":{"id":"t1"}}}';
  const old = process.env.KING_AI_CODEX_VERBOSE;
  process.env.KING_AI_CODEX_VERBOSE = "1";
  try {
    assert.equal(formatEngineLogLine("codex", raw), raw);
  } finally {
    if (old === undefined) delete process.env.KING_AI_CODEX_VERBOSE;
    else process.env.KING_AI_CODEX_VERBOSE = old;
  }
});

test("reduceCodexAppEvent tracks thread and turn lifecycle", () => {
  let state = { activeTurnId: null as string | null, steerGate: false };
  const thread = reduceCodexAppEvent(state, { method: "thread/started", params: { thread: { id: "thread-1" } } });
  assert.equal(thread.threadId, "thread-1");

  state = { activeTurnId: thread.activeTurnId, steerGate: thread.steerGate };
  const turn = reduceCodexAppEvent(state, { method: "turn/started", params: { turn: { id: "turn-1" } } });
  assert.equal(turn.activeTurnId, "turn-1");
  assert.equal(turn.steerGate, false);

  const completed = reduceCodexAppEvent(
    { activeTurnId: "turn-1", steerGate: true },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
  );
  assert.equal(completed.activeTurnId, null);
  assert.equal(completed.steerGate, false);
  assert.equal(completed.turnCompletedError, undefined);
});

test("reduceCodexAppEvent summarizes Codex native app-server events", () => {
  assert.deepEqual(
    reduceCodexAppEvent(
      { activeTurnId: "turn-1", steerGate: false },
      { method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 93.4 } } } },
    ).logs,
    ["[codex] account rate limit at 93% - turns will start failing when it reaches 100%"],
  );
  assert.deepEqual(
    reduceCodexAppEvent(
      { activeTurnId: "turn-1", steerGate: false },
      { method: "item/started", params: { item: { type: "contextCompaction" } } },
    ).logs,
    ["[codex] native context compaction started"],
  );
  assert.deepEqual(
    reduceCodexAppEvent(
      { activeTurnId: "turn-1", steerGate: false },
      { method: "item/completed", params: { item: { type: "contextCompaction" } } },
    ).logs,
    ["[codex] native context compaction finished"],
  );
});

test("reduceCodexAppEvent gates steering around completed items and deltas", () => {
  const completed = reduceCodexAppEvent(
    { activeTurnId: "turn-1", steerGate: false },
    { method: "item/completed", params: { item: { type: "agentMessage", text: "done" } } },
  );
  assert.equal(completed.steerGate, true);
  assert.deepEqual(completed.logs, ["[codex] done"]);

  const delta = reduceCodexAppEvent(
    { activeTurnId: "turn-1", steerGate: true },
    { method: "item/agentMessage/delta", params: { delta: "more" } },
  );
  assert.equal(delta.steerGate, false);
});

test("reduceCodexAppEvent reports failed turn completion", () => {
  const result = reduceCodexAppEvent(
    { activeTurnId: "turn-1", steerGate: true },
    { method: "turn/completed", params: { turn: { status: "failed", error: { message: "quota exhausted" } } } },
  );
  assert.equal(result.activeTurnId, null);
  assert.equal(result.steerGate, false);
  assert.equal(result.turnCompletedError, "quota exhausted");
});

test("Codex app-server session falls back from failed resume to a fresh thread", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-codex-session-"));
  const binDir = join(dir, "bin");
  const imagePath = join(dir, "screen.png");
  await mkdir(binDir);
  await writeFile(imagePath, "png", "utf8");
  const codex = join(binDir, "codex");
  await writeFile(
    codex,
    `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const seen = [];
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  seen.push(msg);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'thread/resume') send({ jsonrpc: '2.0', id: msg.id, error: { message: 'missing thread' } });
  else if (msg.method === 'thread/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'fresh-thread' } } });
  } else if (msg.method === 'turn/start') {
    send({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 4 } } } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '{"replyMarkdown":"ok"}' } } });
    require('node:fs').writeFileSync(process.env.SEEN_FILE, JSON.stringify(seen, null, 2));
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
});
`,
    "utf8",
  );
  await chmod(codex, 0o755);

  const logs: string[] = [];
  const seenFile = join(dir, "seen.json");
  const session = getAdapter("codex").startSession?.({
    home: dir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, SEEN_FILE: seenFile },
    resumeSessionId: "stale-thread",
    standingPrompt: "standing",
    onLog: (line) => logs.push(line),
  });
  assert.ok(session);
  const outputSchema = {
    type: "object",
    properties: { replyMarkdown: { type: "string" } },
    required: ["replyMarkdown"],
    additionalProperties: false,
  };
  const result = await session.send("hello", { imagePaths: [imagePath], outputSchema });
  session.stop();

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "fresh-thread");
  assert.deepEqual(result.usage, {
    input_tokens: 10,
    cache_read_input_tokens: 2,
    output_tokens: 7,
  });
  assert.deepEqual(result.structuredOutput, { replyMarkdown: "ok" });
  assert.match(logs.join("\n"), /thread\/resume failed \(missing thread\) - starting a fresh thread/);
  assert.match(logs.join("\n"), /replyMarkdown/);
  const seen = JSON.parse(await readFile(seenFile, "utf8")) as Array<{
    method?: string;
    params?: { input?: unknown[]; outputSchema?: unknown };
  }>;
  const turnStart = seen.find((msg) => msg.method === "turn/start");
  assert.deepEqual(turnStart?.params?.input, [
    { type: "text", text: "hello", text_elements: [] },
    { type: "localImage", path: imagePath },
  ]);
  assert.deepEqual(turnStart?.params?.outputSchema, outputSchema);
});

test("Claude one-shot run passes --json-schema and reads structured_output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-claude-structured-"));
  const binDir = join(dir, "bin");
  const seenFile = join(dir, "seen.json");
  await mkdir(binDir);
  const claude = join(binDir, "claude");
  await writeFile(
    claude,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.SEEN_FILE, JSON.stringify(process.argv.slice(2)));
const result = process.env.MISSING_OUTPUT
  ? { type: "result", is_error: false, session_id: "claude-session" }
  : { type: "result", is_error: false, session_id: "claude-session", structured_output: { replyMarkdown: "Hello." } };
process.stdout.write(JSON.stringify(result) + "\\n");
`,
    "utf8",
  );
  await chmod(claude, 0o755);
  const outputSchema = {
    type: "object",
    properties: { replyMarkdown: { type: "string" } },
    required: ["replyMarkdown"],
    additionalProperties: false,
  };

  try {
    const result = await getAdapter("claude").run({
      home: dir,
      prompt: "reply",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, SEEN_FILE: seenFile },
      outputSchema,
      signal: AbortSignal.timeout(5000),
      onLog: () => {},
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "claude-session");
    assert.deepEqual(result.structuredOutput, { replyMarkdown: "Hello." });
    const argv = JSON.parse(await readFile(seenFile, "utf8")) as string[];
    assert.deepEqual(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2), [
      "--output-format",
      "json",
    ]);
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]), outputSchema);

    const missing = await getAdapter("claude").run({
      home: dir,
      prompt: "reply",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SEEN_FILE: seenFile,
        MISSING_OUTPUT: "1",
      },
      outputSchema,
      signal: AbortSignal.timeout(5000),
      onLog: () => {},
    });
    assert.equal(missing.exitCode, 1);
    assert.match(missing.error ?? "", /without a valid structured output/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex one-shot run writes --output-schema and parses the final JSON object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-codex-structured-"));
  const binDir = join(dir, "bin");
  const seenFile = join(dir, "seen.json");
  await mkdir(binDir);
  const codex = join(binDir, "codex");
  await writeFile(
    codex,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.SEEN_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ replyMarkdown: "Hello." }, null, 2) + "\\n");
`,
    "utf8",
  );
  await chmod(codex, 0o755);
  const outputSchema = {
    type: "object",
    properties: { replyMarkdown: { type: "string" } },
    required: ["replyMarkdown"],
    additionalProperties: false,
  };

  try {
    const result = await getAdapter("codex").run({
      home: dir,
      prompt: "reply",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, SEEN_FILE: seenFile },
      outputSchema,
      signal: AbortSignal.timeout(5000),
      onLog: () => {},
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.structuredOutput, { replyMarkdown: "Hello." });
    const argv = JSON.parse(await readFile(seenFile, "utf8")) as string[];
    assert.equal(argv[0], "exec");
    const schemaPath = argv[argv.indexOf("--output-schema") + 1];
    assert.deepEqual(JSON.parse(await readFile(schemaPath, "utf8")), outputSchema);
    assert.equal((await stat(schemaPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex app-server session aborts when a turn produces no output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-codex-no-output-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const codex = join(binDir, "codex");
  await writeFile(
    codex,
    `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'thread/start') send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
});
`,
    "utf8",
  );
  await chmod(codex, 0o755);

  const old = process.env.KING_AI_SESSION_NO_OUTPUT_TIMEOUT_MS;
  process.env.KING_AI_SESSION_NO_OUTPUT_TIMEOUT_MS = "25";
  try {
    const session = getAdapter("codex").startSession?.({
      home: dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      standingPrompt: "standing",
      onLog: () => {},
    });
    assert.ok(session);
    const result = await session.send("hello");

    assert.equal(result.exitCode, 124);
    assert.match(result.error ?? "", /codex engine produced no output/);
    assert.match(result.error ?? "", /quota, authentication\/login, or interactive prompt/);
    assert.equal(session.alive, false);
  } finally {
    if (old === undefined) delete process.env.KING_AI_SESSION_NO_OUTPUT_TIMEOUT_MS;
    else process.env.KING_AI_SESSION_NO_OUTPUT_TIMEOUT_MS = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeShim installs the king-ai command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-shim-"));
  await writeShim(dir);
  const mode = (await stat(join(dir, "king-ai"))).mode & 0o777;
  assert.equal(mode, 0o755);
});

test("writeShim reports errors under the invoked command name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-shim-name-"));
  await writeShim(dir);
  await assert.rejects(
    execFileP(join(dir, "king-ai"), [], {
      env: {
        PATH: process.env.PATH,
      },
    }),
    (err) => {
      const actual = err as { code?: number; stderr?: string };
      assert.equal(actual.code, 70);
      assert.match(actual.stderr ?? "", /^king-ai: runtime env not set/);
      return true;
    },
  );
});

test("writeShim forwards --file and --stdin bodies as single CLI args", async () => {
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "ok" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    const dir = await mkdtemp(join(tmpdir(), "king-ai-shim-file-"));
    const bodyPath = join(dir, "reply.md");
    await writeFile(bodyPath, "line 1\n`code` and $var", "utf8");
    await writeShim(dir);

    await execFileP(join(dir, "king-ai"), ["reply", "demo-convo", "--file", bodyPath], {
      env: {
        PATH: process.env.PATH,
        KING_AI_AGENT_RUNTIME_URL: url,
        KING_AI_AGENT_RUNTIME_TOKEN: "token",
        KING_AI_AGENT_ID: "demo-agent",
        KING_AI_AGENT_ENGINE: "claude",
      },
    });
    await runWithStdin(join(dir, "king-ai"), ["reply", "demo-convo", "--stdin"], "from stdin\nwith quotes", {
      PATH: process.env.PATH,
      KING_AI_AGENT_RUNTIME_URL: url,
      KING_AI_AGENT_RUNTIME_TOKEN: "token",
    });

    assert.deepEqual(
      seen.map((row) => row as { argv?: string[]; agentId?: string; engine?: string }),
      [
        { argv: ["reply", "demo-convo", "line 1\n`code` and $var"], agentId: "demo-agent", engine: "claude" },
        { argv: ["reply", "demo-convo", "from stdin\nwith quotes"] },
      ],
    );
  } finally {
    server.close();
  }
});

test("authFailureHint gives engine-specific remediation", () => {
  assert.match(authFailureHint("claude", "not logged in"), /claude authentication is not ready/i);
  assert.match(authFailureHint("codex", "usage limit reached"), /quota or billing limit/);
  assert.match(authFailureHint("codex", "context_length_exceeded"), /context is full/);
  assert.equal(hashText("same"), hashText("same"));
  assert.notEqual(hashText("same"), hashText("different"));
});

test("isRateLimited recognizes engine and HTTP quota failures", () => {
  assert.equal(isRateLimited("HTTP 429 too many requests"), true);
  assert.equal(isRateLimited("RESOURCE_EXHAUSTED quota exceeded"), true);
  assert.equal(isRateLimited("service temporarily unavailable"), true);
  assert.equal(isRateLimited("not logged in"), false);
});

test("splitExtraArgs preserves quoted values", () => {
  assert.deepEqual(splitExtraArgs("--model haiku --flag='two words' --name \"Demo Agent\" escaped\\ value"), [
    "--model",
    "haiku",
    "--flag=two words",
    "--name",
    "Demo Agent",
    "escaped value",
  ]);
});

test("personaHeader documents workspace, memory, and privacy boundaries", () => {
  const header = personaHeader({ id: "demo-agent", name: "Demo Agent", role: "Engineer" });
  assert.match(header, /workspace\/ project files/);
  assert.match(header, /memory\/MEMORY\.md/);
  assert.match(header, /Stay inside this home directory/);
  assert.match(header, /king-ai` command on PATH/);
});

test("codex seedHome refreshes generated persona files", async () => {
  const home = await mkdtemp(join(tmpdir(), "king-ai-home-"));
  try {
    const adapter = getAdapter("codex");
    await adapter.seedHome(home, { id: "ielts-tutor", name: "IELTS Reading & Writing Coach", role: "Old role" });
    await adapter.seedHome(home, {
      id: "ielts-tutor",
      name: "IELTS Reading & Writing Coach",
      role: "New compact role",
    });
    const text = await readFile(join(home, "AGENTS.md"), "utf8");
    assert.match(text, /New compact role/);
    assert.doesNotMatch(text, /Old role/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Grok headless run passes images via --prompt-json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-grok-image-"));
  const binDir = join(dir, "bin");
  const imagePath = join(dir, "photo.png");
  await mkdir(binDir);
  await writeFile(
    imagePath,
    Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    ),
  );
  const seenFile = join(dir, "seen.json");
  const grok = join(binDir, "grok");
  await writeFile(
    grok,
    `#!/usr/bin/env node
const idx = process.argv.indexOf("--prompt-json");
const blocks = idx >= 0 ? JSON.parse(process.argv[idx + 1]) : null;
require("node:fs").writeFileSync(process.env.SEEN_FILE, JSON.stringify({ blocks }, null, 2));
process.stdout.write(JSON.stringify({ type: "text", data: "ok" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "grok-image-session" }) + "\\n");
`,
    "utf8",
  );
  await chmod(grok, 0o755);

  const result = await getAdapter("grok").run({
    home: dir,
    prompt: "describe this",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, SEEN_FILE: seenFile },
    imagePaths: [imagePath],
    signal: AbortSignal.timeout(5000),
    onLog: () => {},
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "grok-image-session");
  const seen = JSON.parse(await readFile(seenFile, "utf8")) as {
    blocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  };
  assert.equal(seen.blocks.length, 2);
  assert.equal(seen.blocks[0]?.type, "image");
  assert.equal(seen.blocks[0]?.mimeType, "image/png");
  assert.match(seen.blocks[0]?.data ?? "", /^iVBOR/);
  assert.deepEqual(seen.blocks[1], { type: "text", text: "describe this" });
  await rm(dir, { recursive: true, force: true });
});

test("Grok headless run passes model and reasoning effort flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-grok-reasoning-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const seenFile = join(dir, "seen.json");
  const grok = join(binDir, "grok");
  await writeFile(
    grok,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.SEEN_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "text", data: "ok" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "grok-reasoning-session" }) + "\\n");
`,
    "utf8",
  );
  await chmod(grok, 0o755);

  const result = await getAdapter("grok").run({
    home: dir,
    prompt: "hello",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, SEEN_FILE: seenFile },
    model: "grok-chat-fast",
    reasoningEffort: " low ",
    signal: AbortSignal.timeout(5000),
    onLog: () => {},
  });

  assert.equal(result.exitCode, 0);
  const argv = JSON.parse(await readFile(seenFile, "utf8")) as string[];
  assert.deepEqual(argv.slice(argv.indexOf("-m"), argv.indexOf("-m") + 2), ["-m", "grok-chat-fast"]);
  assert.deepEqual(argv.slice(argv.indexOf("--reasoning-effort"), argv.indexOf("--reasoning-effort") + 2), [
    "--reasoning-effort",
    "low",
  ]);
  await rm(dir, { recursive: true, force: true });
});

test("Grok session streams structuredOutput when KING_AI_GROK_STREAM_STRUCTURED=1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-grok-structured-"));
  const binDir = join(dir, "bin");
  const seenFile = join(dir, "seen.json");
  await mkdir(binDir);
  const grok = join(binDir, "grok");
  await writeFile(
    grok,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.SEEN_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "thought", data: "draft" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", data: "Hello." }) + "\\n");
const endEvent = JSON.stringify({
  type: "end",
  stopReason: "EndTurn",
  sessionId: "grok-structured-session",
  modelId: "grok-test",
  usage: { input_tokens: 4, output_tokens: 2 },
  structuredOutput: { replyMarkdown: "Hello." }
}) + "\\n";
// Split the end event across two chunks to exercise the partial-line reassembly path.
process.stdout.write(endEvent.slice(0, 25));
setTimeout(() => process.stdout.write(endEvent.slice(25)), 30);
`,
    "utf8",
  );
  await chmod(grok, 0o755);
  const outputSchema = {
    type: "object",
    properties: { replyMarkdown: { type: "string" } },
    required: ["replyMarkdown"],
    additionalProperties: false,
  };

  try {
    const logs: string[] = [];
    const session = getAdapter("grok").startSession?.({
      home: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SEEN_FILE: seenFile,
        KING_AI_GROK_STREAM_STRUCTURED: "1",
      },
      standingPrompt: "standing",
      onLog: (line) => logs.push(line),
    });
    assert.ok(session);
    const result = await session.send("reply", { outputSchema });
    session.stop();

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "grok-structured-session");
    assert.deepEqual(result.structuredOutput, { replyMarkdown: "Hello." });
    assert.deepEqual(result.usage, { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 });
    assert.equal(result.model, "grok-test");
    assert.ok(logs.some((line) => line.includes("(thinking) draft")));
    assert.ok(logs.some((line) => line === "[grok] Hello."));
    // The chunk-split end event must be reassembled, never logged as raw fragments.
    assert.ok(logs.some((line) => line === "[grok] turn completed"));
    assert.ok(!logs.some((line) => line.includes("stopReason")));
    const argv = JSON.parse(await readFile(seenFile, "utf8")) as string[];
    assert.deepEqual(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2), [
      "--output-format",
      "streaming-json",
    ]);
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]), outputSchema);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Grok session defaults structured turns to one-shot json output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-grok-structured-json-"));
  const binDir = join(dir, "bin");
  const seenFile = join(dir, "seen.json");
  await mkdir(binDir);
  const grok = join(binDir, "grok");
  await writeFile(
    grok,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.SEEN_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({
  stopReason: "EndTurn",
  sessionId: "grok-structured-oneshot",
  modelId: "grok-test",
  usage: { input_tokens: 4, output_tokens: 2 },
  structuredOutput: { replyMarkdown: "Hello." }
}) + "\\n");
`,
    "utf8",
  );
  await chmod(grok, 0o755);
  const outputSchema = {
    type: "object",
    properties: { replyMarkdown: { type: "string" } },
    required: ["replyMarkdown"],
    additionalProperties: false,
  };

  try {
    const session = getAdapter("grok").startSession?.({
      home: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SEEN_FILE: seenFile,
        KING_AI_GROK_STREAM_STRUCTURED: "",
      },
      standingPrompt: "standing",
      onLog: () => {},
    });
    assert.ok(session);
    const result = await session.send("reply", { outputSchema });
    session.stop();

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "grok-structured-oneshot");
    assert.deepEqual(result.structuredOutput, { replyMarkdown: "Hello." });
    const argv = JSON.parse(await readFile(seenFile, "utf8")) as string[];
    assert.deepEqual(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2), [
      "--output-format",
      "json",
    ]);
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]), outputSchema);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Grok headless session resumes after a stale session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-grok-session-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const grok = join(binDir, "grok");
  await writeFile(
    grok,
    `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";
const resume = process.argv.includes("--resume");
if (resume) {
  process.stdout.write(JSON.stringify({ type: "error", message: "Couldn't create session: Session does not exist" }) + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: "text", data: "ok" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "fresh-grok-session" }) + "\\n");
`,
    "utf8",
  );
  await chmod(grok, 0o755);

  const logs: string[] = [];
  const session = getAdapter("grok").startSession?.({
    home: dir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    resumeSessionId: "stale-grok-session",
    standingPrompt: "standing",
    onLog: (line) => logs.push(line),
  });
  assert.ok(session);
  const result = await session.send("hello");
  session.stop();

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "fresh-grok-session");
  assert.match(logs.join("\n"), /starting a fresh session/);
  await rm(dir, { recursive: true, force: true });
});

test("grok seedHome refreshes generated persona files", async () => {
  const home = await mkdtemp(join(tmpdir(), "king-ai-grok-home-"));
  try {
    const adapter = getAdapter("grok");
    await adapter.seedHome(home, { id: "demo", name: "Demo Agent", role: "Old role" });
    await adapter.seedHome(home, { id: "demo", name: "Demo Agent", role: "New role" });
    const text = await readFile(join(home, "AGENTS.md"), "utf8");
    assert.match(text, /New role/);
    assert.doesNotMatch(text, /Old role/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("codex seedHome preserves non-generated persona files", async () => {
  const home = await mkdtemp(join(tmpdir(), "king-ai-home-"));
  try {
    await writeFile(join(home, "AGENTS.md"), "# Custom\n\nDo not replace this file.\n", "utf8");
    const adapter = getAdapter("codex");
    await adapter.seedHome(home, { id: "demo", name: "Demo", role: "Generated role" });
    const text = await readFile(join(home, "AGENTS.md"), "utf8");
    assert.equal(text, "# Custom\n\nDo not replace this file.\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
