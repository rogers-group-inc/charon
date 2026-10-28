/**
 * src/api/routes/settings/apiTokens.ts — Server Settings: API Tokens tab.
 *
 * Ported from polaris (src/api/routes/serverSettings.ts and friends) to back
 * the ported public/js/server-settings-api-tokens.js module at the exact paths public/js/settings-api.js
 * calls. Mounted WITHOUT a router-level gate (router.ts) — every route declares
 * its own requirePermission(), because a router.use() gate here would also
 * fire for every other /server-settings path that passes through this router.
 */

import { Router } from "express";

const router = Router();

export default router;

/** Mounted at /api/v1/api-tokens (polaris path). */
export const apiTokensRouter = Router();
