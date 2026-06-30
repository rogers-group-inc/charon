/**
 * src/services/agentTokenService.ts — Endpoint-agent bearer tokens.
 *
 * Separate from ApiToken: agent bearers are bound to an Endpoint row and issued
 * during enrollment (one-time invitation code → one-shot enrollment token →
 * long-lived bearer). Wire format `charon_<base64url>`; stored ONLY as a
 * SHA-384 hash server-side, prefix-indexed for lookup.
 *
 * Enrollment + telemetry live in the `endpoint` role; this module is the shared
 * verify/issue surface.
 */

import { prisma } from "../db.js";
import { generateToken, sha384hex, timingSafeHexEqual } from "../utils/crypto.js";

const BEARER_PREFIX = "charon";
const PREFIX_DISPLAY_LEN = 12;

export interface VerifiedAgent {
  endpointId: string;
}

/** Issue a fresh bearer for an endpoint, returning the plaintext ONCE. */
export async function issueBearer(endpointId: string): Promise<string> {
  const { plaintext, hash } = generateToken(BEARER_PREFIX);
  await prisma.endpoint.update({
    where: { id: endpointId },
    data: {
      bearerHash: hash,
      bearerPrefix: plaintext.slice(0, PREFIX_DISPLAY_LEN),
      bearerIssuedAt: new Date(),
      bearerRevokedAt: null,
    },
  });
  return plaintext;
}

/** Revoke an endpoint's bearer (locks the agent out). */
export async function revokeBearer(endpointId: string): Promise<void> {
  await prisma.endpoint.update({
    where: { id: endpointId },
    data: { bearerRevokedAt: new Date(), status: "revoked" },
  });
}

/**
 * Verify a presented agent bearer. Returns the bound endpoint id, or null when
 * unknown/revoked. Updates last-seen best-effort.
 */
export async function verifyBearer(raw: string, callerIp: string | null): Promise<VerifiedAgent | null> {
  if (!raw.startsWith(BEARER_PREFIX + "_")) return null;
  const prefix = raw.slice(0, PREFIX_DISPLAY_LEN);
  const candidates = await prisma.endpoint.findMany({
    where: { bearerPrefix: prefix, bearerRevokedAt: null },
  });
  const hash = sha384hex(raw);
  for (const c of candidates) {
    if (!c.bearerHash || !timingSafeHexEqual(c.bearerHash, hash)) continue;
    void prisma.endpoint
      .update({ where: { id: c.id }, data: { lastSeenAt: new Date(), lastSeenIp: callerIp } })
      .catch(() => {});
    return { endpointId: c.id };
  }
  return null;
}
