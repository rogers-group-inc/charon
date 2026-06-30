/**
 * src/api/middleware/rateLimits.ts — Shared rate limiters.
 *
 * The login limiter caps credential-stuffing on the unauthenticated login +
 * agent enrollment surfaces. Mounted in app.ts.
 */

import rateLimit from "express-rate-limit";

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
