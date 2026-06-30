/**
 * src/api/middleware/auth.ts — Session + bearer-token authentication.
 *
 * Two parallel auth surfaces:
 *   - Session (UI/browser): cookie-bearing requests. RBAC enforced by
 *     `requirePermission(functionKey, level)` from ./permissions.ts.
 *   - Bearer token (external): `Authorization: Bearer charon_<...>` from a
 *     long-lived API token, scoped to a fixed list of capabilities.
 *
 * Agent endpoints use a third surface — the per-endpoint agent bearer — via
 * `requireAgentBearer` below.
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";
import { verifyToken } from "../../services/apiTokenService.js";
import { verifyBearer as verifyAgentBearer } from "../../services/agentTokenService.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId || req.apiToken) return next();
  next(new AppError(401, "Unauthorized — please log in"));
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") return null;
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolve a bearer token (if any) and attach it to req.apiToken. Always calls
 * next() — does not enforce on its own. Mounted globally below session/CSRF so
 * downstream routes can opt in via the hybrid guards.
 */
export async function attachApiToken(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = extractBearerToken(req);
    if (!raw) return next();
    const callerIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const token = await verifyToken(raw, callerIp);
    if (token) req.apiToken = token;
    next();
  } catch {
    next();
  }
}

/**
 * Charon agent bearer guard. Verifies against the Endpoint bearer store and
 * attaches { endpointId } to req.agent. 401 on missing/invalid. Used by every
 * /api/v1/agents/* route EXCEPT /enroll (which uses the one-shot enrollment
 * token in the body).
 */
export async function requireAgentBearer(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = extractBearerToken(req);
    if (!raw) return next(new AppError(401, "Unauthorized — agent bearer required"));
    const callerIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const verified = await verifyAgentBearer(raw, callerIp);
    if (!verified) return next(new AppError(401, "Unauthorized — agent bearer invalid or revoked"));
    req.agent = verified;
    next();
  } catch (err) {
    next(err);
  }
}
