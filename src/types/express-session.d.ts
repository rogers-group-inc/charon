/**
 * src/types/express-session.d.ts — Ambient augmentation of Express types.
 *
 * Declares the session fields Charon stores plus the per-request auth handles
 * (bearer-token caller, agent caller, resolved permission level).
 */

import type { SessionRoleSnapshot, AccessLevel } from "../api/middleware/permissions.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    username?: string;
    role?: string; // denormalized role name (legacy/quick reads)
    roleId?: string;
    roleSnapshot?: SessionRoleSnapshot;
    csrfToken?: string;
    lastActivity?: number;
    // Pending second-factor: set after password verify, before TOTP verify.
    mfaPendingUserId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Set by attachApiToken when a valid bearer token is presented. */
      apiToken?: { id: string; name: string; scopes: string[] };
      /** Set by requireAgentBearer when a valid agent bearer is presented. */
      agent?: { endpointId: string };
      /** Set by requirePermission after a successful check. */
      permissionLevel?: AccessLevel;
    }
  }
}

export {};
