import test from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekClient, runDeepSeekSmokeTest } from "../src/ai-service.mjs";

const config = {
  deepseekApiKey: "test-key",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-flash",
  deepseekTimeoutMs: 1000,
};

test("DeepSeek smoke test uses the server-side flash model in non-thinking mode", async () => {
  let request;
  const result = await runDeepSeekSmokeTest(config, { fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return jsonResponse(200, {
      model: "deepseek-v4-flash",
      choices: [{ message: { content: "HYPERRECON_DEEPSEEK_OK" } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
  } });

  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer test-key");
  assert.equal(request.body.model, "deepseek-v4-flash");
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.equal(result.content, "HYPERRECON_DEEPSEEK_OK");
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 4, totalTokens: 16 });
});

test("DeepSeek client requests provider-enforced JSON when selected", async () => {
  let body;
  const client = createDeepSeekClient({ ...clientConfig(), fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse(200, { choices: [{ message: { content: "{}" } }] });
  } });
  await client.complete({ messages: [{ role: "user", content: "probe" }], responseFormat: "json_object" });
  assert.deepEqual(body.response_format, { type: "json_object" });
  await assert.rejects(client.complete({ messages: [{ role: "user", content: "probe" }], responseFormat: "text" }), { code: "INVALID_AI_RESPONSE_FORMAT" });
});

test("DeepSeek client converts authentication failures without exposing provider bodies", async () => {
  const client = createDeepSeekClient({ ...clientConfig(), fetchImpl: async () => jsonResponse(401, { error: { message: "secret provider detail" } }) });
  await assert.rejects(client.complete({ messages: [{ role: "user", content: "probe" }] }), (error) => {
    assert.equal(error.code, "AI_PROVIDER_AUTH_FAILED");
    assert.equal(error.message.includes("secret provider detail"), false);
    return true;
  });
});

test("DeepSeek client rejects malformed successful responses", async () => {
  const client = createDeepSeekClient({ ...clientConfig(), fetchImpl: async () => jsonResponse(200, { choices: [] }) });
  await assert.rejects(client.complete({ messages: [{ role: "user", content: "probe" }] }), { code: "AI_PROVIDER_INVALID_RESPONSE" });
});

test("DeepSeek client aborts requests at the configured timeout", async () => {
  const client = createDeepSeekClient({ ...clientConfig(), timeoutMs: 10, fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }) });
  await assert.rejects(client.complete({ messages: [{ role: "user", content: "probe" }] }), { code: "AI_PROVIDER_TIMEOUT" });
});

function clientConfig() {
  return { apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: config.deepseekModel, timeoutMs: config.deepseekTimeoutMs };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "provider-request-test" } });
}
