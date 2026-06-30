/**
 * src/api/routes/agent.ts — Public agent-facing config (no auth, no secrets).
 *
 * On launch the endpoint agent calls GET /api/v1/agent/auth-config to learn
 * which login mode the server dictates (local | saml | oidc) and renders the
 * matching flow in its webview. This is intentionally public — it carries no
 * secrets, only the active mode + display params.
 */

import { Router } from "express";
import { getAgentAuthConfig } from "../../services/authService.js";

const router = Router();

router.get("/auth-config", async (_req, res, next) => {
  try {
    res.json(await getAgentAuthConfig());
  } catch (err) {
    next(err);
  }
});

export default router;
