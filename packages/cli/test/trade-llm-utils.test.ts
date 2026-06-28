import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJsonFromText, resetAgentBackendBlocks, runAgent, summarizeAgentError } from "../src/trade/llm-utils.js";

test("extractJsonFromText parses fenced JSON array", () => {
  const parsed = extractJsonFromText('prefix\n```json\n[{"a":1}]\n```\nsuffix');
  assert.deepEqual(parsed, [{ a: 1 }]);
});

test("extractJsonFromText parses bare object", () => {
  const parsed = extractJsonFromText('answer {"ok":true} done');
  assert.deepEqual(parsed, { ok: true });
});

test("summarizeAgentError redacts long prompts and classifies quota/auth failures", () => {
  const prompt = "你是一个加密货币事件交易分析师。".repeat(80);
  const quota = summarizeAgentError(new Error(`Command failed: grok -p ${prompt}
personal-team-blocked:spending-limit: You have run out of credits or need a Grok subscription.`));
  assert.equal(quota, "quota blocked: Grok credits or subscription required");

  const auth = summarizeAgentError(new Error("Failed to authenticate. API Error: 401 Invalid authentication credentials"));
  assert.equal(auth, "auth failed: invalid or expired credentials");

  const stdoutAuth = new Error("Command failed: claude --print");
  (stdoutAuth as Error & { stdout: string }).stdout = "Failed to authenticate. API Error: 401 Invalid authentication credentials";
  (stdoutAuth as Error & { stderr: string }).stderr = "Warning: no stdin data received";
  assert.equal(summarizeAgentError(stdoutAuth), "auth failed: invalid or expired credentials");

  const generic = summarizeAgentError(new Error(`Command failed: agent ${prompt}`));
  assert.ok(generic.length <= 1000);
  assert.doesNotMatch(generic, /交易分析师。交易分析师。交易分析师/);

  const detailed = new Error("Command failed: codex exec prompt");
  (detailed as Error & { code: number; stderr: string; stdout: string }).code = 1;
  (detailed as Error & { stderr: string }).stderr = "first stderr line\nsecond stderr line";
  (detailed as Error & { stdout: string }).stdout = "partial answer";
  const detailSummary = summarizeAgentError(detailed);
  assert.match(detailSummary, /exit=1/);
  assert.match(detailSummary, /stderr=first stderr line second stderr line/);
  assert.match(detailSummary, /stdout=partial answer/);
});

test("runAgent skips temporarily blocked auth/quota backends", async () => {
  resetAgentBackendBlocks();
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = await mkdtemp(join(tmpdir(), "king-ai-llm-utils-"));
  const bin = join(dir, "bin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  await writeFile(join(bin, "grok"), "#!/bin/sh\necho 'personal-team-blocked:spending-limit' >&2\nexit 1\n");
  await writeFile(join(bin, "claude"), "#!/bin/sh\necho ok\n");
  await chmod(join(bin, "grok"), 0o755);
  await chmod(join(bin, "claude"), 0o755);

  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.HOME = dir;
  try {
    const first = await runAgent("hello", { timeoutMs: 5000 });
    const second = await runAgent("hello", { timeoutMs: 5000 });
    assert.equal(first, "ok");
    assert.equal(second, "ok");
  } finally {
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    resetAgentBackendBlocks();
  }
});
