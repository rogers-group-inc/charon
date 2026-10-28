/**
 * src/api/middleware/rateLimits.ts — Shared rate limiters.
 *
 * The login limiter caps credential-stuffing on the unauthenticated login +
 * agent enrollment surfaces. Mounted in app.ts. The agent-login and
 * admin-action limiters are attached per route in their route files.
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/** Build an ad-hoc limiter (used by the first-run setup server). */
export function makeRateLimiter(opts: { windowMs: number; max: number; message: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: opts.message },
  });
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
});

// Agent enrollment: a one-time invitation code is presented here. Rate-limit by
// IP so a leaked-but-revoked code can't be brute-forced for residual uses.
export const enrollLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many enrollment attempts. Please try again later." },
});

// Agent-side local login: the bearer is already verified, but the password is
// guessable. Key by endpoint, not IP — a whole fleet can sit behind one NAT
// address, and per-IP would let one endpoint lock out every other one.
export const agentLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.agent?.endpointId ?? ipKeyGenerator(req.ip ?? ""),
  message: { error: "Too many login attempts from this device. Please try again in 15 minutes." },
});

// Destructive administrator actions (backup restore, in-app update, restart,
// certificate upload). Already permission-gated; this caps a stolen session or
// API token, or a runaway script. Keyed by operator so admins sharing a jump
// host don't throttle each other.
export const adminActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session?.username ?? ipKeyGenerator(req.ip ?? ""),
  message: { error: "Too many administrative actions. Please wait 15 minutes and try again." },
});
