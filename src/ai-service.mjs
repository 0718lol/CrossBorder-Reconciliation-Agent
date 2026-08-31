const providerName = "deepseek";

export function createDeepSeekClient({ apiKey, baseUrl, model, timeoutMs, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw codedError("AI_NOT_CONFIGURED");
  if (typeof fetchImpl !== "function") throw codedError("AI_TRANSPORT_UNAVAILABLE");

  return Object.freeze({
    async complete({ messages, maxTokens = 256, responseFormat = null }) {
      validateMessages(messages);
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 2048) throw codedError("INVALID_AI_MAX_TOKENS");
      if (responseFormat !== null && responseFormat !== "json_object") throw codedError("INVALID_AI_RESPONSE_FORMAT");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            thinking: { type: "disabled" },
            max_tokens: maxTokens,
            stream: false,
            ...(responseFormat ? { response_format: { type: responseFormat } } : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === "AbortError") throw codedError("AI_PROVIDER_TIMEOUT");
        throw codedError("AI_PROVIDER_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw codedError(response.status === 401 || response.status === 403 ? "AI_PROVIDER_AUTH_FAILED" : "AI_PROVIDER_ERROR", {
          status: response.status,
          providerRequestId: response.headers.get("x-request-id") || null,
        });
      }

      let payload;
      try { payload = await response.json(); }
      catch { throw codedError("AI_PROVIDER_INVALID_RESPONSE"); }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw codedError("AI_PROVIDER_INVALID_RESPONSE");

      return {
        provider: providerName,
        model: typeof payload.model === "string" ? payload.model : model,
        content: content.trim(),
        usage: normalizeUsage(payload.usage),
        providerRequestId: response.headers.get("x-request-id") || null,
      };
    },
  });
}

export async function runDeepSeekSmokeTest(config, options = {}) {
  const client = createDeepSeekClient({
    apiKey: config.deepseekApiKey,
    baseUrl: config.deepseekBaseUrl,
    model: config.deepseekModel,
    timeoutMs: config.deepseekTimeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return client.complete({
    messages: [
      { role: "system", content: "You are a connectivity probe. Follow the output instruction exactly." },
      { role: "user", content: "Reply with exactly HYPERRECON_DEEPSEEK_OK and nothing else." },
    ],
    maxTokens: 32,
  });
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) throw codedError("INVALID_AI_MESSAGES");
  for (const message of messages) {
    if (!["system", "user", "assistant"].includes(message?.role)
      || typeof message.content !== "string"
      || message.content.length < 1
      || message.content.length > 12000) throw codedError("INVALID_AI_MESSAGES");
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const completionTokens = Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : null;
  const totalTokens = Number.isInteger(usage.total_tokens) ? usage.total_tokens : null;
  return { promptTokens, completionTokens, totalTokens };
}

function codedError(code, metadata = {}) {
  return Object.assign(new Error(code), { code, metadata });
}
