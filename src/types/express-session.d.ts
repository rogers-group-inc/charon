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
    // Last time sessionRevalidate confirmed the user row still exists (ms).
    checkedAt?: number;
    // A login that is partly complete (second factor or forced password
    // change still owed) — utils/pendingAuth.ts. Not authenticated.
    pendingAuth?: import("../utils/pendingAuth.js").PendingAuth;
    // How this session signed in: "local" | "ldap" | "saml" | "oidc" | "entra-proxy" | "passkey".
    authProvider?: string;
    // SSO hand-off (pre-auth; dropped by the session rotation at sign-in,
    // except the SAML logout pair which is stamped after it).
    samlRelayState?: string;
    samlNameID?: string;
    samlSessionIndex?: string;
    oidcState?: string;
    oidcNonce?: string;
    oidcCodeVerifier?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Set by attachApiToken when a valid bearer token is presented. */
      apiToken?: { id: string; name: string; roleId: string | null; scopes: string[] };
      /** Set by requireAgentBearer when a valid agent bearer is presented. */
      agent?: { endpointId: string };
      /** Set by requirePermission after a successful check. */
      permissionLevel?: AccessLevel;
      /** The caller's resolved role (bearer token or session), set by requirePermission. */
      roleSnapshot?: SessionRoleSnapshot;
    }
  }
}

export {};
