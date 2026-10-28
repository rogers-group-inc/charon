/**
 * src/api/routes/settings/credentials.ts — Server Settings: Credentials tab (credentials, MIBs, manufacturer profiles).
 *
 * Ported from polaris (src/api/routes/serverSettings.ts and friends) to back
 * the ported public/js/server-settings-credentials.js module at the exact paths public/js/settings-api.js
 * calls. Mounted WITHOUT a router-level gate (router.ts) — every route declares
 * its own requirePermission(), because a router.use() gate here would also
 * fire for every other /server-settings path that passes through this router.
 */

import { Router } from "express";

const router = Router();

export default router;

/** Mounted at /api/v1/credentials (polaris path). */
export const credentialsRouter = Router();
