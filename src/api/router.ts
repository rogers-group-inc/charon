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
import { agentsEnrollRouter, agentsRouter } from "./routes/agents.js";
import { requireAuth, attachApiToken } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";

export const router = Router();

// Resolve any presented bearer token before any auth gate runs.
router.use(attachApiToken);

// ─── Public surfaces ─────────────────────────────────────────────────────────
// Operator auth (login/logout/me) and the agent's public auth-config probe.
router.use("/auth", authRouter);
router.use("/agent", agentRouter);

// Agent protocol — enrollment (invitation code) + bearer-guarded telemetry.
// Mounted BEFORE requireAuth: agents present a one-shot code or a per-agent
// bearer, never a session. The WS upgrade (/agents/ws) is handled separately in
// app.ts on the HTTP server.
router.use("/agents/enroll", agentsEnrollRouter);
router.use("/agents", agentsRouter);

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
router.use("/server-settings", requirePermission("serverSettingsSystem", "read"), serverSettingsRouter);
router.use("/events", requirePermission("events", "read"), eventsRouter);
