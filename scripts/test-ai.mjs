import { runDeepSeekSmokeTest } from "../src/ai-service.mjs";
import { loadConfig } from "../src/config.mjs";

try {
  const result = await runDeepSeekSmokeTest(loadConfig());
  if (result.content !== "HYPERRECON_DEEPSEEK_OK") throw Object.assign(new Error("AI_SMOKE_OUTPUT_MISMATCH"), { code: "AI_SMOKE_OUTPUT_MISMATCH" });
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    providerRequestId: result.providerRequestId,
    output: result.content,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    code: error.code || "AI_SMOKE_FAILED",
    metadata: error.metadata || {},
  }, null, 2)}\n`);
  process.exitCode = 1;
}
