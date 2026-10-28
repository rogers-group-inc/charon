/**
 * src/api/middleware/sessionRevalidate.ts — a session is only as good as the
 * account behind it (ported from polaris).
 *
 * Authorization reads the role snapshot stored IN the session, and requireAuth
 * only checks that `req.session.userId` is set. Neither asks whether the user
 * still exists or still holds that role. Account-changing routes revoke
 * sessions directly (sessionRevocationService); this is the backstop for every
 * other path (a direct DB change, an SSO group-mapping change, a restore).
 *
 * Once per SESSION_RECHECK_MS per session it confirms the user row exists and
 * carries the role the session believes. A missing user ends the session; a
 * changed role is adopted, which makes the snapshot resolver reload the new
 * matrix. One primary-key read per session per minute, not per request. A
 * database error fails OPEN — an outage must not log everybody out.
 */

import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../db.js";

export const SESSION_RECHECK_MS = 60_000;

export async function revalidateSessionUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const session = req.session;
    const userId = session?.userId;
    if (!session || !userId) return next();

    const now = Date.now();
    if (now - (session.checkedAt ?? 0) < SESSION_RECHECK_MS) return next();

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, roleId: true } });
    if (!user) {
      // The account is gone: start over with an empty, unauthenticated session.
      await new Promise<void>((resolve) => session.regenerate(() => resolve()));
      return next();
    }
    if (session.roleId && session.roleId !== user.roleId) session.roleId = user.roleId;
    session.checkedAt = now;
  } catch {
    /* fail open: never turn a database error into a mass logout */
  }
  next();
}
