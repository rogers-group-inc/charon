import { describe, it, expect, beforeAll } from "vitest";
import { encryptSecret, decryptSecret, isEncryptedEnvelope, sha384hex, generateToken, timingSafeHexEqual } from "../../src/utils/crypto.ts";

beforeAll(() => {
  // Deterministic 32-byte key for the test process.
  process.env.CHARON_DATA_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("crypto/at-rest", () => {
  it("round-trips a secret through AES-256-GCM", () => {
    const env = encryptSecret("super-secret-token");
    expect(isEncryptedEnvelope(env)).toBe(true);
    expect(env.startsWith("c1.aes-256-gcm.")).toBe(true);
    expect(decryptSecret(env)).toBe("super-secret-token");
  });

  it("produces a different envelope each time (random IV)", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("rejects a tampered envelope", () => {
    const env = encryptSecret("hello");
    const parts = env.split(".");
    parts[5] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("hashes tokens and compares in constant time", () => {
    const { plaintext, hash } = generateToken("charon");
    expect(plaintext.startsWith("charon_")).toBe(true);
    expect(timingSafeHexEqual(sha384hex(plaintext), hash)).toBe(true);
    expect(timingSafeHexEqual(sha384hex("other"), hash)).toBe(false);
  });
});
