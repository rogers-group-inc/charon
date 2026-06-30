/**
 * src/services/verificationService.ts — Bind {user ↔ device ↔ IP}.
 *
 * On a successful agent user-login the server binds the verified directory
 * identity to the endpoint + its current IP, creating a short-lived
 * VerificationSession. This binding is what the tag reconciler reads
 * (endpoint.boundUserKey) to resolve user-derived tags. Logout (or expiry)
 * clears it, which reconciles the endpoint back to its unbound tag set.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventService.js";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h, matches operator sessions

export async function bindVerification(
  endpointId: string,
  input: { userKey: string; userName?: string; ip: string | null; mode: "local" | "saml" | "oidc" },
): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.endpoint.update({
      where: { id: endpointId },
      data: { boundUserKey: input.userKey, boundUserName: input.userName ?? input.userKey, boundAt: now, currentIp: input.ip ?? undefined },
    }),
    // Revoke any prior active session for this endpoint, then open a new one.
    prisma.verificationSession.updateMany({ where: { endpointId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.verificationSession.create({
      data: { endpointId, userKey: input.userKey, userName: input.userName ?? input.userKey, ip: input.ip, mode: input.mode, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
    }),
  ]);
  await logEvent({ action: "agent.login", resourceType: "endpoint", resourceId: endpointId, actor: input.userKey, message: `${input.userKey} verified on endpoint ${endpointId} (${input.mode})` });
}

export async function clearBinding(endpointId: string): Promise<void> {
  const ep = await prisma.endpoint.findUnique({ where: { id: endpointId }, select: { boundUserKey: true } });
  await prisma.$transaction([
    prisma.endpoint.update({ where: { id: endpointId }, data: { boundUserKey: null, boundUserName: null, boundAt: null } }),
    prisma.verificationSession.updateMany({ where: { endpointId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await logEvent({ action: "agent.logout", resourceType: "endpoint", resourceId: endpointId, actor: ep?.boundUserKey ?? undefined, message: `Cleared user binding on endpoint ${endpointId}` });
}
