/**
 * src/api/router.ts — Aggregate API routes under /api/v1.
 *
 * Order matters: public surfaces (auth, agent config, agent enroll/comms) mount
 * BEFORE the blanket requireAuth gate. Everything below requireAuth needs a
 * session OR a bearer token; per-resource role gates are applied at each mount
 * via requirePermission.
 *
 * Resource routers are added per milestone (integrations, endpoints, tags,
 * policies, groups, users, server-settings…). The scaffold wires auth + agent
 * config + the audit log to exercise the full middleware chain end-to-end.
 */

import { Router } from "express";
import authRouter from "./routes/auth.js";
import authSsoRouter from "./routes/authSso.js";
import authPasskeysRouter from "./routes/authPasskeys.js";
import agentRouter from "./routes/agent.js";
import eventsRouter from "./routes/events.js";
import integrationsRouter from "./routes/integrations.js";
import tagsRouter from "./routes/tags.js";
import groupsRouter from "./routes/groups.js";
import directoryRouter from "./routes/directory.js";
import endpointsRouter from "./routes/endpoints.js";
import policiesRouter from "./routes/policies.js";
import serverSettingsRouter from "./routes/serverSettings.js";
import maintenanceRouter from "./routes/maintenance.js";
import settingsNtpRouter from "./routes/settings/ntp.js";
import settingsIdentificationRouter, { deviceIconsRouter, assetTypesRouter } from "./routes/settings/identification.js";
import settingsWebServerRouter from "./routes/settings/webServer.js";
import settingsMaintenanceRouter from "./routes/settings/maintenance.js";
import settingsCustomizationRouter, { publicBrandingRouter } from "./routes/settings/customization.js";
import settingsCredentialsRouter, { credentialsRouter } from "./routes/settings/credentials.js";
import settingsApiTokensRouter, { apiTokensRouter } from "./routes/settings/apiTokens.js";
import settingsHaRouter, { haRouter, haEnrollRouter } from "./routes/settings/ha.js";
import settingsFirmwareRouter from "./routes/settings/firmware.js";
import usersRouter from "./routes/users.js";
import rolesRouter from "./routes/roles.js";
import groupMappingsRouter from "./routes/groupMappings.js";
import { agentsEnrollRouter, agentsRouter } from "./routes/agents.js";
import { requireAuth, attachApiToken } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";
import { revalidateSessionUser } from "./middleware/sessionRevalidate.js";

export const router = Router();

// Resolve any presented bearer token before any auth gate runs, then confirm
// (once a minute per session) that the session's account still exists.
router.use(attachApiToken);
router.use(revalidateSessionUser);

// ─── Public surfaces ─────────────────────────────────────────────────────────
// Operator auth (login/logout/me) and the agent's public auth-config probe.
router.use("/auth", authRouter);
router.use("/auth", authSsoRouter); // SAML / OIDC / App Proxy flows + provider settings (self-gated)
router.use("/auth", authPasskeysRouter); // passkey sign-in, second factor, self-service, policy (self-gated)
router.use("/agent", agentRouter);
// Login-page branding (name, subtitle, opt-in logo) — read before sign-in.
router.use("/branding", publicBrandingRouter);

// Agent protocol — enrollment (invitation code) + bearer-guarded telemetry.
// Mounted BEFORE requireAuth: agents present a one-shot code or a per-agent
// bearer, never a session. The WS upgrade (/agents/ws) is handled separately in
// app.ts on the HTTP server.
router.use("/agents/enroll", agentsEnrollRouter);
router.use("/agents", agentsRouter);

// HA node enrollment (the node scripts the High Availability tab mints).
// Public by design: the caller holds a single-use, SHA-384-hashed enrollment
// token, then waits for an operator to approve it in the UI before it can
// download its bundle (src/services/haEnrollmentService.ts). Rate-limited and
// CSRF-exempt at exactly this path (middleware/csrf.ts).
router.use("/ha/enroll", haEnrollRouter);

// ─── Authenticated surfaces ────────────────────────────────────────────────
router.use(requireAuth);
router.use("/endpoints", requirePermission("endpoints", "read"), endpointsRouter);
router.use("/integrations", requirePermission("integrations", "read"), integrationsRouter);
router.use("/directory", requirePermission("directory", "read"), directoryRouter);
router.use("/groups", requirePermission("groups", "read"), groupsRouter);
router.use("/tags", requirePermission("tags", "read"), tagsRouter);
router.use("/policies", requirePermission("policies", "read"), policiesRouter);
// Maintenance mounts BEFORE the blanket /server-settings gate so its
// serverSettingsData guard applies instead of serverSettingsSystem.
router.use("/server-settings/maintenance", maintenanceRouter);
// Server Settings tabs ported from polaris (public/js/server-settings-*.js),
// at polaris's paths. Also BEFORE the blanket gate, because the tabs ride
// different keys (credentials, apiTokens, serverSettingsData) — each route
// in these files declares its own requirePermission().
for (const r of [
  settingsNtpRouter, settingsIdentificationRouter, settingsWebServerRouter,
  settingsMaintenanceRouter, settingsCustomizationRouter, settingsCredentialsRouter,
  settingsApiTokensRouter, settingsHaRouter, settingsFirmwareRouter,
]) router.use("/server-settings", r);
router.use("/credentials", credentialsRouter);
router.use("/api-tokens", apiTokensRouter);
router.use("/ha", haRouter);
router.use("/device-icons", deviceIconsRouter);
router.use("/asset-types", assetTypesRouter);
router.use("/server-settings", requirePermission("serverSettingsSystem", "read"), serverSettingsRouter);
router.use("/events", requirePermission("events", "read"), eventsRouter);
router.use("/users", requirePermission("users", "read"), usersRouter);
// Roles gate per route (roles:read / roles:write) — no mount gate.
router.use("/roles", rolesRouter);
router.use("/group-mappings", requirePermission("users", "fullwrite"), groupMappingsRouter);
