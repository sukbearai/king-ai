import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSshCommand, redactRemoteSecrets, sshExec } from "../src/remote-ssh.js";

test("buildSshCommand uses sshpass env for plain password devices", () => {
  const built = buildSshCommand({
    id: "test-61",
    host: "10.12.9.61",
    user: "root",
    password: "secret"
  }, "hostname");
  assert.equal(built.program, "sshpass");
  assert.deepEqual(built.args.slice(0, 3), ["-e", "ssh", "-o"]);
  assert.equal(built.args.includes("secret"), false);
  assert.equal(built.env.SSHPASS, "secret");
});

test("sshExec redacts remote secrets from output", async () => {
  const result = await sshExec({
    id: "test-61",
    host: "10.12.9.61",
    user: "root",
    password: "secret"
  }, "echo ok", {
    executor: async () => ({
      ok: true,
      exitCode: 0,
      stdout: "secret ok\n",
      stderr: "secret warn\n",
      truncated: false,
      durationMs: 1
    })
  });
  assert.equal(result.stdout, "<redacted> ok\n");
  assert.equal(result.stderr, "<redacted> warn\n");
  assert.equal(result.evidence[0]?.kind, "command");
});

test("redactRemoteSecrets handles passwordEnv", () => {
  assert.equal(redactRemoteSecrets("token from env-secret", {
    id: "test-61",
    host: "10.12.9.61",
    user: "root",
    passwordEnv: "REMOTE_PASSWORD"
  }, { REMOTE_PASSWORD: "env-secret" }), "token from <redacted>");
});
