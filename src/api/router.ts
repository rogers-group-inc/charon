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
import { requireAuth, attachApiToken } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";

export const router = Router();

// Resolve any presented bearer token before any auth gate runs.
router.use(attachApiToken);

// ─── Public surfaces ─────────────────────────────────────────────────────────
// Operator auth (login/logout/me) and the agent's public auth-config probe.
router.use("/auth", authRouter);
router.use("/agent", agentRouter);

// NOTE: /agents/* (enrollment + telemetry) mounts here in the endpoint-agent
// milestone, BEFORE requireAuth — agents present a one-shot enrollment token or
// a per-agent bearer, never a session.

// ─── Authenticated surfaces ────────────────────────────────────────────────
router.use(requireAuth);
router.use("/events", requirePermission("events", "read"), eventsRouter);
