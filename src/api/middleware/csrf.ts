/**
 * src/api/middleware/csrf.ts — Synchronizer-token CSRF protection.
 *
 * A random token is generated per session and stored in the session store
 * (HttpOnly). The same value is mirrored into a readable cookie so same-origin
 * JavaScript in our own pages can echo it in an `X-CSRF-Token` header on
 * state-changing requests. A cross-origin attacker can forge a POST but cannot
 * read the token cookie (Same-Origin Policy), so cannot supply a valid header.
 *
 * Defense-in-depth on top of `SameSite=Lax` + strict JSON content types.
 */

import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { AppError } from "../../utils/errors.js";

const COOKIE_NAME = "charon_csrf";
const HEADER_NAME = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Paths that bypass the token check. All other mutating requests are protected.
const EXEMPT_PATH_PREFIXES = [
  "/api/v1/auth/login", // pre-session; the rate limiter is the defense
  "/api/v1/auth/saml/", // SAML flow is cross-origin by design; signed assertion + RelayState are the CSRF guarantee
  "/api/v1/auth/oidc/", // OIDC redirect/callback; state + PKCE are the guarantee
  "/api/setup/", // first-run wizard runs on a separate server without sessions
  // Charon agent endpoints — agents are programmatic clients with NO browser
  // session. /enroll authenticates via the one-shot enrollment token in the
  // body; /heartbeat, /posture, /config, /ws authenticate via the per-agent
  // bearer in the Authorization header. Token-based auth is the CSRF defense.
  "/api/v1/agents/",
  "/api/v1/agent/", // public agent auth-config probe (GET only anyway)
];

export function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.session) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = randomBytes(32).toString("hex");
    }
    if (!req.secure) {
      res.clearCookie(COOKIE_NAME, { path: "/", secure: true, sameSite: "lax" });
    }
    res.cookie(COOKIE_NAME, req.session.csrfToken, {
      httpOnly: false, // frontend JS must read this
      sameSite: "lax",
      secure: req.secure,
      path: "/",
    });
  }

  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();

  const fromHeader = req.get(HEADER_NAME);
  const fromSession = req.session?.csrfToken;
  if (!fromHeader || !fromSession || fromHeader !== fromSession) {
    const cookieHeader = req.get("cookie") || "";
    const cookieMissing = !cookieHeader.includes(`${COOKIE_NAME}=`);
    if (!req.secure && cookieMissing) {
      return next(
        new AppError(
          403,
          "CSRF cookie missing — your browser may hold a stale cookie from a previous HTTPS install on this address. Clear cookies for this site and reload.",
        ),
      );
    }
    return next(new AppError(403, "CSRF token missing or invalid"));
  }
  next();
}
