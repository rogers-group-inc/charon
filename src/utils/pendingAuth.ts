/**
 * src/utils/pendingAuth.ts — a login that is partly complete: the password
 * (or passkey) was right, but the session is not issued yet.
 *
 * Polaris kept this in a process-local Map behind an opaque token; Charon keeps
 * it IN the session (`req.session.pendingAuth`), which connect-pg-simple stores
 * in Postgres, so the next step can land on either node of an HA pair. The
 * session is NOT authenticated while it carries only pendingAuth — `userId`
 * is set only by establishSession().
 *
 * Two kinds of next step, by `purpose`:
 *
 *   "mfa"             a second factor is still owed — a TOTP / backup code or
 *                     a passkey assertion (see `methods`).
 *   "password-change" every factor passed, but the password just typed fails
 *                     the complexity policy and the operator asked for those
 *                     to be changed at login. Buys exactly one thing: the
 *                     right to set a new password and receive the withheld
 *                     session.
 *
 * A "password-change" stamp is ONLY minted after all factors are satisfied.
 * Minting it at the password step would let a stolen password set a new one
 * without ever facing the second factor.
 *
 * Revocation: sessionRevocationService.revokeUserSessions() deletes sessions
 * whose pendingAuth.userId matches, so an admin reset kills half-finished
 * logins too.
 */

import type { Request } from "express";

export type PendingPurpose = "mfa" | "password-change";

/** Which second factors this account can actually finish the login with. */
export interface PendingMethods {
  totp: boolean;
  passkey: boolean;
}

export interface PendingAuth {
  userId: string;
  username: string;
  purpose: PendingPurpose;
  methods: PendingMethods;
  /** The accepted password fails the current policy: force a change after the second factor. */
  mustChangePassword: boolean;
  /** How the first factor was satisfied — carried into the session's authProvider. */
  authProvider: string;
  expiresAt: number; // epoch ms
}

export const PENDING_TTL_MS = 5 * 60 * 1000;

export function setPending(
  req: Request,
  entry: Omit<PendingAuth, "expiresAt">,
  now: number = Date.now(),
): void {
  req.session.pendingAuth = { ...entry, expiresAt: now + PENDING_TTL_MS };
}

/**
 * The live pending entry for `purpose`, or null (absent, expired, or a
 * different step). Does not consume — a wrong TOTP code may be retried.
 */
export function peekPending(req: Request, purpose: PendingPurpose, now: number = Date.now()): PendingAuth | null {
  const p = req.session?.pendingAuth;
  if (!p || p.purpose !== purpose) return null;
  if (p.expiresAt <= now) {
    delete req.session.pendingAuth;
    return null;
  }
  return p;
}

export function clearPending(req: Request): void {
  if (req.session) delete req.session.pendingAuth;
}
