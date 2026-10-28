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
 * Resolve a bearer token (if any) and attach it to req.apiToken. Does not
 * enforce permissions on its own — requirePermission resolves the token's
 * bound role downstream. Mounted globally below session/CSRF.
 *
 * One refusal happens here (polaris port): a REAL token presented from outside
 * its trusted hosts is answered 403 naming the address Charon saw — behind a
 * proxy with `trust proxy` unset that is the proxy's own address, the most
 * likely reason a correct list "fails". Unknown/revoked/expired tokens fall
 * through as "no token" and the downstream guard answers 401.
 */
export async function attachApiToken(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = extractBearerToken(req);
    if (!raw) return next();
    const callerIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const result = await verifyToken(raw, callerIp);
    if (result.ok) {
      req.apiToken = result.token;
    } else if (result.reason === "untrusted_host") {
      return next(
        new AppError(
          403,
          `API token "${result.tokenName}" is not accepted from ${result.callerIp || "this source address"} — ` +
            "add the address to the token's trusted hosts, or if Charon sits behind a reverse proxy, check the trust-proxy setting",
        ),
      );
    }
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
