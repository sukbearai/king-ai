import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPlan, generateImage, parseArgs } from "../scripts/generate.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "clirelay-imagegen-test-"));
  const promptFile = path.join(root, "prompt.txt");
  const output = path.join(root, "image.png");
  writeFileSync(promptFile, "一只戴宇航员头盔的橘猫\n", { mode: 0o600 });
  return { output, promptFile, root };
}

test("dry-run validates the plan without insecure transport acknowledgement", () => {
  const { output, promptFile } = fixture();
  const plan = buildPlan(parseArgs(["--dry-run", "--prompt-file", promptFile, "--output", output]));

  assert.equal(plan.model, "gpt-image-2");
  assert.equal(plan.size, "1024x1024");
  assert.equal(plan.quality, "high");
  assert.equal(plan.promptChars, 11);
  assert.match(plan.promptSha256, /^[a-f0-9]{64}$/);
});

test("real generation fails closed without explicit HTTP acknowledgement", () => {
  const { output, promptFile } = fixture();

  assert.throws(
    () => buildPlan(parseArgs(["--prompt-file", promptFile, "--output", output])),
    /Plain HTTP is not acknowledged/,
  );
});

test("generation sends the environment key in the authorization header and saves base64 output", async () => {
  const { output, promptFile } = fixture();
  const plan = buildPlan(parseArgs(["--allow-insecure-http", "--prompt-file", promptFile, "--output", output]));
  let request;
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const fetchImpl = async (_url, init) => {
    request = init;
    return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  };

  const result = await generateImage(plan, "test-secret", fetchImpl);

  assert.equal(request.headers.Authorization, "Bearer test-secret");
  assert.deepEqual(JSON.parse(request.body), {
    model: "gpt-image-2",
    n: 1,
    prompt: "一只戴宇航员头盔的橘猫",
    quality: "high",
    size: "1024x1024",
  });
  assert.deepEqual(readFileSync(output), pngBytes);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(result.source, "b64_json");
  assert.equal(result.format, "png");
});

test("API errors redact the bearer key", async () => {
  const { output, promptFile } = fixture();
  const plan = buildPlan(parseArgs(["--allow-insecure-http", "--prompt-file", promptFile, "--output", output]));
  const fetchImpl = async () => new Response("invalid test-secret", { status: 401 });

  await assert.rejects(
    () => generateImage(plan, "test-secret", fetchImpl),
    (error) => {
      assert.doesNotMatch(error.message, /test-secret/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("non-image base64 responses are rejected", async () => {
  const { output, promptFile } = fixture();
  const plan = buildPlan(parseArgs(["--allow-insecure-http", "--prompt-file", promptFile, "--output", output]));
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("not-an-image").toString("base64") }] }), {
      status: 200,
    });

  await assert.rejects(() => generateImage(plan, "test-secret", fetchImpl), /not a recognized/);
});

test("URL responses are downloaded without forwarding the bearer key", async () => {
  const { output, promptFile } = fixture();
  const plan = buildPlan(parseArgs(["--allow-insecure-http", "--prompt-file", promptFile, "--output", output]));
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ init, url: String(url) });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ data: [{ url: "https://images.example/generated.png" }] }), {
        status: 200,
      });
    }
    return new Response(pngBytes, { status: 200 });
  };

  const result = await generateImage(plan, "test-secret", fetchImpl);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://images.example/generated.png");
  assert.equal(requests[1].init.headers, undefined);
  assert.equal(result.source, "url");
  assert.deepEqual(readFileSync(output), pngBytes);
});
