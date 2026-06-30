/**
 * src/utils/crypto.ts — Crypto-agile primitives for at-rest secrets + hashing.
 *
 * SECURITY MODEL (the repo is public): every algorithm choice here is named in
 * the ciphertext/envelope, never inferred, so algorithms can rotate without a
 * data migration. Nothing is hidden — security lives in the keys, not the code.
 *
 *   • At-rest secrets (integration tokens, API credentials, SAML/OIDC client
 *     secrets, backup envelopes): AES-256-GCM. Quantum-resistant today (Grover
 *     only halves symmetric strength → AES-256 ≈ 128-bit PQ security).
 *   • Hashing: SHA-384 / SHA-512 (FIPS 180-4; quantum-resistant).
 *   • Bearer-token storage: tokens are stored ONLY as a SHA-384 hash server-
 *     side; the plaintext is shown once at issuance and never persisted.
 *   • Passwords: argon2id — see utils/password.ts (separate module).
 *
 * Key material:
 *   The data-encryption key comes from CHARON_DATA_KEY (32 bytes, base64 or
 *   hex). In production this is provisioned from Key Vault / env by the
 *   installer, never hardcoded. A missing key in production is fatal; dev
 *   derives an ephemeral key with a loud warning so `npm run dev` works.
 *
 * Envelope format (string, URL-safe): `c1.<alg>.<keyId>.<iv>.<tag>.<ct>`
 *   - `c1`     — envelope version (lets the format itself evolve)
 *   - `<alg>`  — symmetric algorithm id, e.g. `aes-256-gcm`
 *   - `<keyId>`— key identifier (supports staged key rotation)
 *   - remaining fields base64url. The whole string is what lands in Postgres.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { logger } from "./logger.js";

// ─── Algorithm registry (crypto-agility) ───────────────────────────────────
export const SYMMETRIC_ALG = "aes-256-gcm" as const;
export const HASH_ALG_DEFAULT = "sha384" as const;

const ENVELOPE_VERSION = "c1";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256
const DEFAULT_KEY_ID = "k1";

// ─── Key resolution ─────────────────────────────────────────────────────────
let cachedKey: Buffer | null = null;

function parseKeyMaterial(raw: string): Buffer | null {
  const s = raw.trim();
  // Accept base64 or hex; require exactly 32 bytes after decode.
  for (const enc of ["base64", "hex"] as const) {
    try {
      const buf = Buffer.from(s, enc);
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      /* try next */
    }
  }
  return null;
}

function resolveDataKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.CHARON_DATA_KEY;
  if (raw) {
    const parsed = parseKeyMaterial(raw);
    if (!parsed) {
      throw new Error(
        "CHARON_DATA_KEY is set but is not a valid 32-byte key (base64 or hex). " +
          "Generate one with: openssl rand -base64 32",
      );
    }
    cachedKey = parsed;
    return cachedKey;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "CHARON_DATA_KEY is required when NODE_ENV=production. At-rest secret " +
        "encryption cannot start without it. Provision a 32-byte key from Key " +
        "Vault / env (openssl rand -base64 32).",
    );
  }
  // Dev only: derive a stable-per-process ephemeral key so the app boots.
  // Secrets encrypted under this key do NOT survive a restart — that's fine
  // for dev, fatal for prod (guarded above).
  logger.warn(
    "CHARON_DATA_KEY is unset — deriving an EPHEMERAL dev key. At-rest secrets " +
      "will not survive a restart. Set CHARON_DATA_KEY for any real use.",
  );
  cachedKey = randomBytes(KEY_BYTES);
  return cachedKey;
}

// ─── At-rest encryption (AES-256-GCM) ───────────────────────────────────────

/** Encrypt a UTF-8 plaintext into a self-describing envelope string. */
export function encryptSecret(plaintext: string, keyId: string = DEFAULT_KEY_ID): string {
  const key = resolveDataKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(SYMMETRIC_ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    SYMMETRIC_ALG,
    keyId,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/** True when a string looks like a Charon at-rest envelope. */
export function isEncryptedEnvelope(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENVELOPE_VERSION + ".");
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}. Throws on a malformed
 * envelope, unknown algorithm, or authentication-tag mismatch (tamper).
 */
export function decryptSecret(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 6 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("Malformed secret envelope");
  }
  const [, alg, , ivB64, tagB64, ctB64] = parts;
  if (alg !== SYMMETRIC_ALG) {
    throw new Error(`Unsupported secret algorithm "${alg}"`);
  }
  const key = resolveDataKey();
  const iv = Buffer.from(ivB64, "base64url");
  const decipher = createDecipheriv(SYMMETRIC_ALG, key, iv);
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

// ─── Hashing (SHA-384 / SHA-512) ────────────────────────────────────────────

export function sha384hex(input: string | Buffer): string {
  return createHash("sha384").update(input).digest("hex");
}

export function sha512hex(input: string | Buffer): string {
  return createHash("sha512").update(input).digest("hex");
}

/** SHA-256 hex of a buffer — used for certificate leaf fingerprints (the agent pin). */
export function sha256hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

// ─── Bearer-token issuance + verification ───────────────────────────────────

/**
 * Generate a random opaque token with a recognizable prefix. The plaintext is
 * returned to the caller exactly once; only its SHA-384 hash is ever stored.
 */
export function generateToken(prefix: string, bytes = 32): { plaintext: string; hash: string } {
  const secret = randomBytes(bytes).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  return { plaintext, hash: sha384hex(plaintext) };
}

/** Constant-time comparison of two hex digests of equal length. */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ─── Secret masking (API boundary) ──────────────────────────────────────────
// Secrets are encrypted at rest AND masked when projected back to the API so a
// GET never returns the plaintext. On write, a resubmitted mask (or empty
// string) preserves the stored value rather than overwriting it.

export const SECRET_MASK = "••••••••";

export function isMaskedValue(v: unknown): boolean {
  return typeof v === "string" && (v === SECRET_MASK || v.trim() === "");
}
