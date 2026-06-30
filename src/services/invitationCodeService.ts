/**
 * src/services/invitationCodeService.ts — One-time agent enrollment codes.
 *
 * An operator issues a code (shown once); the agent presents it to /enroll and
 * swaps it for a long-lived bearer. Only the SHA-384 hash is stored. Codes can
 * carry a use cap + expiry and are prefix-indexed for lookup.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { generateToken, sha384hex, timingSafeHexEqual } from "../utils/crypto.js";
import { logEvent } from "./eventService.js";

const CODE_PREFIX = "charon-inv";
const PREFIX_DISPLAY_LEN = 14;

export interface IssuedCode {
  id: string;
  label: string | null;
  plaintext: string; // shown ONCE
  expiresAt: Date | null;
  maxUses: number;
}

export async function issueCode(input: { label?: string; maxUses?: number; expiresInHours?: number }, actor: string): Promise<IssuedCode> {
  const { plaintext, hash } = generateToken(CODE_PREFIX, 24);
  const expiresAt = input.expiresInHours && input.expiresInHours > 0
    ? new Date(Date.now() + input.expiresInHours * 3600 * 1000)
    : null;
  const row = await prisma.invitationCode.create({
    data: {
      label: input.label ?? null,
      codeHash: hash,
      codePrefix: plaintext.slice(0, PREFIX_DISPLAY_LEN),
      maxUses: input.maxUses && input.maxUses > 0 ? input.maxUses : 1,
      expiresAt,
      createdBy: actor,
    },
  });
  await logEvent({ action: "invitation.issued", resourceType: "invitation", resourceId: row.id, resourceName: input.label ?? undefined, actor, message: `Issued invitation code${input.label ? ` "${input.label}"` : ""}` });
  return { id: row.id, label: row.label, plaintext, expiresAt: row.expiresAt, maxUses: row.maxUses };
}

export async function listCodes() {
  const rows = await prisma.invitationCode.findMany({ orderBy: { createdAt: "desc" } });
  // codeHash is never returned; codePrefix is safe for display.
  return rows.map((r) => ({
    id: r.id, label: r.label, codePrefix: r.codePrefix, maxUses: r.maxUses, useCount: r.useCount,
    expiresAt: r.expiresAt, createdBy: r.createdBy, createdAt: r.createdAt, revokedAt: r.revokedAt,
  }));
}

export async function revokeCode(id: string, actor: string): Promise<void> {
  const row = await prisma.invitationCode.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Invitation code not found");
  await prisma.invitationCode.update({ where: { id }, data: { revokedAt: new Date() } });
  await logEvent({ action: "invitation.revoked", resourceType: "invitation", resourceId: id, actor, message: "Revoked invitation code" });
}

/**
 * Verify + atomically consume one use of a code. Returns the code id on success;
 * throws AppError(403) when unknown/revoked/expired/exhausted. The use-count
 * bump uses a conditional update so two concurrent enrollments can't exceed
 * maxUses.
 */
export async function consumeCode(raw: string): Promise<string> {
  if (!raw.startsWith(CODE_PREFIX + "_")) throw new AppError(403, "Invalid invitation code");
  const prefix = raw.slice(0, PREFIX_DISPLAY_LEN);
  const candidates = await prisma.invitationCode.findMany({ where: { codePrefix: prefix, revokedAt: null } });
  const hash = sha384hex(raw);
  const now = new Date();
  for (const c of candidates) {
    if (!timingSafeHexEqual(c.codeHash, hash)) continue;
    if (c.expiresAt && c.expiresAt < now) throw new AppError(403, "Invitation code has expired");
    // Conditional increment: only succeeds while useCount < maxUses.
    const updated = await prisma.invitationCode.updateMany({
      where: { id: c.id, useCount: { lt: c.maxUses }, revokedAt: null },
      data: { useCount: { increment: 1 } },
    });
    if (updated.count === 0) throw new AppError(403, "Invitation code has no remaining uses");
    return c.id;
  }
  throw new AppError(403, "Invalid invitation code");
}
