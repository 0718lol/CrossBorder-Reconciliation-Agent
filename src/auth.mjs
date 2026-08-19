import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, keyLength);
  return `scrypt$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [algorithm, saltHex, hashHex, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || extra || !/^[0-9a-f]{32}$/.test(saltHex || "") || !/^[0-9a-f]{128}$/.test(hashHex || "")) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), keyLength));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function issueSessionToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function secretsEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function validateEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error("Invalid email");
  return value;
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) throw new Error("Password must contain 12 to 256 characters");
}
