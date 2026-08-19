import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, hashSessionToken, issueSessionToken, secretsEqual, validateEmail, verifyPassword } from "../src/auth.mjs";

test("password hash is salted and verifies without storing plaintext", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password value", first), false);
  assert.equal(first.includes("correct horse"), false);
});

test("malformed hashes fail closed", async () => {
  assert.equal(await verifyPassword("anything long enough", "broken"), false);
  await assert.rejects(() => hashPassword("short"), /12 to 256/);
});

test("session tokens have a one-way stored representation", () => {
  const { token, tokenHash } = issueSessionToken();
  assert.equal(token.length, 43);
  assert.equal(tokenHash, hashSessionToken(token));
  assert.equal(tokenHash.includes(token), false);
});

test("secret comparison handles unequal lengths without throwing", () => {
  assert.equal(secretsEqual("bootstrap-secret", "bootstrap-secret"), true);
  assert.equal(secretsEqual("short", "a-much-longer-secret"), false);
  assert.equal(secretsEqual(undefined, "secret"), false);
});

test("email is normalized and malformed addresses are rejected", () => {
  assert.equal(validateEmail(" User@Example.COM "), "user@example.com");
  assert.throws(() => validateEmail("not-an-email"), /Invalid email/);
});
