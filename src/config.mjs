import { resolve } from "node:path";

export function loadConfig(env = process.env) {
  const config = {
    port: readInteger(env.PORT, 4180, 1, 65535),
    demoMode: env.DEMO_MODE === "true" || env.DEMO_MODE === "1",
    databaseUrl: env.DATABASE_URL || "postgres://hyperrecon:hyperrecon_dev_only@127.0.0.1:55432/hyperrecon",
    sessionTtlSeconds: readInteger(env.SESSION_TTL_SECONDS, 28800, 300, 86400),
    maxUploadBytes: readInteger(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    bootstrapToken: env.BOOTSTRAP_TOKEN || "",
    objectStorageDir: resolve(env.OBJECT_STORAGE_DIR || ".data/objects"),
    deepseekApiKey: env.DEEPSEEK_API_KEY || "",
    deepseekBaseUrl: readHttpsUrl(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"),
    deepseekModel: readIdentifier(env.DEEPSEEK_MODEL || "deepseek-v4-flash", "DEEPSEEK_MODEL"),
    deepseekTimeoutMs: readInteger(env.DEEPSEEK_TIMEOUT_MS, 15000, 1000, 60000),
  };
  return Object.freeze(config);
}

function readHttpsUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`Invalid HTTPS URL configuration: ${value}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid HTTPS URL configuration: ${value}`);
  }
  return url.href.replace(/\/$/, "");
}

function readIdentifier(value, name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value)) throw new Error(`Invalid ${name} configuration`);
  return value;
}

function readInteger(value, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid integer configuration: ${value}`);
  return parsed;
}
