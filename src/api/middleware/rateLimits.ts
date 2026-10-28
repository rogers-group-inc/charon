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

// Auth-code guessing surfaces (TOTP confirm / disable): mirror the login limiter.
export const totpCodeLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many code attempts. Please try again in 15 minutes.",
});

// Password change (self-service and the forced step at login). The body
// carries a current password, so a hijacked session could grind it here
// without touching the login limiter — it gets the login ceiling.
export const passwordChangeLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many password change attempts. Please try again in 15 minutes.",
});

// Passkey ceremonies (option fetch + assertion / registration). An assertion
// is not guessable; this bounds flood volume.
export const passkeyCeremonyLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: "Too many passkey attempts. Please try again in 15 minutes.",
});

// Unauthenticated SSO entry redirects (GET /saml/login, /oidc/login). Nothing
// is guessed — this bounds flood volume — and it is NOT the login limiter, so
// SSO keeps working when the password surface is exhausted. Sized against the
// callback limiter: one sign-in is one entry + one callback from the same
// address, and an office behind one NAT arrives together at shift start.
export const ssoEntryLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: "Too many sign-in attempts — please try again shortly.",
});

// IdP-driven SSO callbacks and the public login-page probes. They carry a
// signature-validated assertion, not a guessable credential; per-IP and far
// above the entry limiter for the same NAT reason.
export const ssoCallbackLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 300,
  message: "Too many sign-in attempts — please try again shortly.",
});

// Entra App Proxy header login: every App Proxy user arrives from the shared
// connector IP(s), so the per-IP login limiter would lock out the whole
// external population. No guessable credential here — bounds a runaway loop.
export const entraProxyLoginLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: "Too many login attempts — retry shortly.",
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
