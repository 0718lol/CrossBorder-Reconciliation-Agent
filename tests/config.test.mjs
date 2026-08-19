import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";

test("configuration has bounded numeric values", () => {
  const config = loadConfig({ PORT: "4181", MAX_UPLOAD_BYTES: "4096", SESSION_TTL_SECONDS: "600", OBJECT_STORAGE_DIR: ".tmp" });
  assert.equal(config.port, 4181);
  assert.equal(config.maxUploadBytes, 4096);
  assert.throws(() => loadConfig({ PORT: "70000" }), /Invalid integer/);
  assert.throws(() => loadConfig({ MAX_UPLOAD_BYTES: "0" }), /Invalid integer/);
});
