/**
 * src/services/sessionRevocationService.ts — end a user's live sessions, and
 * report who is online (ported from polaris).
 *
 * A session carries its own role snapshot and `userId` and nothing else ties it
 * back to the account, so deleting a user, changing their role, or resetting
 * their password / second factor / passkeys must cut their sessions off
 * explicitly. The revalidation middleware (sessionRevalidate.ts) is the
 * backstop for paths that don't.
 *
 * Sessions live in the `session` table owned by connect-pg-simple, not by
 * Prisma's schema, so this is raw SQL. BEST EFFORT by design: the change that
 * triggered a revocation has already been committed, and a failure here must
 * not turn into a failed request.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

/**
 * Delete every session belonging to `userId` — signed in, OR half-way through
 * a login (password accepted, second factor / forced change pending: the
 * `pendingAuth` stamp) — except `keepSid` (the caller's own, when acting on
 * themselves). A pending step minted against an old password or a revoked
 * passkey must not survive the change. One set-based statement. Returns how
 * many were removed, or 0 when the store could not be reached.
 */
export async function revokeUserSessions(userId: string, keepSid?: string): Promise<number> {
  try {
    const removed = await prisma.$executeRaw`
      DELETE FROM session
      WHERE ((sess::jsonb)->>'userId' = ${userId}
             OR (sess::jsonb)->'pendingAuth'->>'userId' = ${userId})
        AND sid <> ${keepSid ?? ""}
    `;
    return Number(removed);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "Could not revoke the user's sessions");
    return 0;
  }
}

/**
 * The user ids holding a live (unexpired) session — the Users page's online
 * dot. Selects only the userId out of the JSON so 2000 sessions stay cheap.
 * Empty when the session table doesn't exist yet (first boot).
 */
export async function getOnlineUserIds(): Promise<Set<string>> {
  try {
    const rows = await prisma.$queryRaw<{ uid: string | null }[]>`
      SELECT DISTINCT (sess::jsonb)->>'userId' AS uid FROM session WHERE expire > NOW()
    `;
    return new Set(rows.map((r) => r.uid).filter((x): x is string => !!x));
  } catch {
    return new Set();
  }
}
