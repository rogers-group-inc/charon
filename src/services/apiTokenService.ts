/**
 * src/services/apiTokenService.ts — Long-lived bearer tokens for external callers.
 *
 * Tokens are `charon_<base64url>`; only their SHA-384 hash is stored (the
 * plaintext is shown once at mint time). Lookup is prefix-indexed then
 * constant-time compared against the stored hash.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { generateToken, sha384hex, timingSafeHexEqual } from "../utils/crypto.js";

const TOKEN_PREFIX = "charon";
const PREFIX_DISPLAY_LEN = 12;

export interface VerifiedApiToken {
  id: string;
  name: string;
  scopes: string[];
}

export interface MintedToken {
  id: string;
  name: string;
  plaintext: string; // returned ONCE
  scopes: string[];
}

export async function mintToken(input: {
  name: string;
  scopes: string[];
  createdBy: string;
  expiresAt?: Date | null;
}): Promise<MintedToken> {
  const name = input.name.trim();
  if (!name) throw new AppError(400, "Token name is required");
  const existing = await prisma.apiToken.findUnique({ where: { name } });
  if (existing) throw new AppError(409, `A token named "${name}" already exists`);
  const { plaintext, hash } = generateToken(TOKEN_PREFIX);
  const row = await prisma.apiToken.create({
    data: {
      name,
      tokenHash: hash,
      tokenPrefix: plaintext.slice(0, PREFIX_DISPLAY_LEN),
      scopes: input.scopes,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    },
  });
  return { id: row.id, name: row.name, plaintext, scopes: row.scopes };
}

/**
 * Verify a presented bearer token. Returns the token identity or null when the
 * token is unknown, revoked, or expired. Updates last-used metadata best-effort.
 */
export async function verifyToken(raw: string, callerIp: string | null): Promise<VerifiedApiToken | null> {
  if (!raw.startsWith(TOKEN_PREFIX + "_")) return null;
  const prefix = raw.slice(0, PREFIX_DISPLAY_LEN);
  const candidates = await prisma.apiToken.findMany({ where: { tokenPrefix: prefix } });
  const hash = sha384hex(raw);
  const now = new Date();
  for (const c of candidates) {
    if (!timingSafeHexEqual(c.tokenHash, hash)) continue;
    if (c.revokedAt) return null;
    if (c.expiresAt && c.expiresAt < now) return null;
    void prisma.apiToken
      .update({ where: { id: c.id }, data: { lastUsedAt: now, lastUsedIp: callerIp } })
      .catch(() => {});
    return { id: c.id, name: c.name, scopes: c.scopes };
  }
  return null;
}
