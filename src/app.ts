/**
 * src/app.ts — Full application server.
 *
 * Only imported when DATABASE_URL is configured (setup complete). Branches on
 * roleConfig() so a single codebase boots as web / endpoint / enforcer / worker
 * / all. Roles coordinate ONLY through Postgres + pg-boss.
 *
 *   web/all  → public Express app (UI + /api/v1 + /health + /metrics); leader-
 *              elected schedulers; one-shot migrations.
 *   endpoint → public Express app too (nginx routes agent traffic here); no
 *              schedulers.
 *   enforcer → pg-boss enforcement consumers + metrics-only listener.
 *   worker   → pg-boss worker consumers (sync/reconcile/posture/health) +
 *              metrics-only listener.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import pg from "pg";
import helmet from "helmet";
import compression from "compression";
import { router } from "./api/router.js";
import { errorHandler } from "./api/middleware/errorHandler.js";
import { csrfMiddleware } from "./api/middleware/csrf.js";
import { loginLimiter, enrollLimiter } from "./api/middleware/rateLimits.js";
import { logger } from "./utils/logger.js";
import { UPLOADS_DIR } from "./utils/paths.js";
import { roleConfig, type RoleConfig } from "./utils/role.js";
import {
  renderMetrics,
  startHttpRequestTimer,
  incHttpInFlight,
  decHttpInFlight,
  statusToClass,
  recordProcessRole,
} from "./metrics.js";
import { startLeaderElection, stopLeaderElection } from "./services/leaderElection.js";
import { stopBoss } from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfg = roleConfig();
recordProcessRole(cfg.role);
logger.info(
  {
    role: cfg.role,
    runsHttp: cfg.runsHttp,
    runsAgentComms: cfg.runsAgentComms,
    runsEnforcement: cfg.runsEnforcement,
    runsWorkers: cfg.runsWorkers,
    runsSchedulers: cfg.runsSchedulers,
  },
  `Charon process role: ${cfg.role}`,
);

// A process binds the public Express listener when it serves the UI/API (web)
// or agent comms (endpoint). enforcer/worker bind only a metrics-only listener.
const BINDS_PUBLIC_LISTENER = cfg.runsHttp || cfg.runsAgentComms;

// ─── Session secret ──────────────────────────────────────────────────────────
function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is required when NODE_ENV=production. Set a long random value in .env.",
    );
  }
  return "charon-dev-secret-change-in-production";
}

const app = express();

// nginx terminates TLS and is the only hop in front of the app; trust the
// first proxy so req.secure / req.ip reflect X-Forwarded-* correctly.
app.set("trust proxy", 1);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No inline <script> blocks — all page JS is external under /js.
        scriptSrc: ["'self'"],
        // on* handler attributes are still used via innerHTML on some pages.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ─── Session ───────────────────────────────────────────────────────────────────
const PgStore = pgSession(session);
const sessionPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
app.use(
  session({
    store: new PgStore({ pool: sessionPool, createTableIfMissing: true }),
    secret: resolveSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: "auto", sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 },
  }),
);

app.use(csrfMiddleware);

// ─── HTTP request metrics ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/metrics" || req.path === "/health") return next();
  incHttpInFlight();
  const stopTimer = startHttpRequestTimer();
  let observed = false;
  const finalize = () => {
    if (observed) return;
    observed = true;
    decHttpInFlight();
    const route = req.route?.path
      ? (req.baseUrl ?? "") + (typeof req.route.path === "string" ? req.route.path : "unmatched")
      : "unmatched";
    stopTimer(req.method, route, statusToClass(res.statusCode));
  };
  res.once("finish", finalize);
  res.once("close", finalize);
  next();
});

// ─── Rate limiting on unauthenticated surfaces ──────────────────────────────────
app.use("/api/v1/auth/login", loginLimiter);
app.use("/api/v1/agents/enroll", enrollLimiter);

// Protect dashboard pages — redirect unauthenticated users to login.
const protectedPages = [
  "/", "/index.html", "/endpoints.html", "/tags.html", "/groups.html",
  "/integrations.html", "/users.html", "/server-settings.html", "/events.html",
];
app.use((req, res, next) => {
  if (!protectedPages.includes(req.path)) return next();
  if (!req.session?.userId) return res.redirect("/login.html");
  return next();
});

app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(path.resolve(__dirname, "..", "public")));

// ─── Health + metrics ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const expected = process.env.HEALTH_TOKEN;
  if (expected) {
    const auth = req.get("authorization") || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (supplied !== expected) return res.status(401).json({ error: "Unauthorized" });
  }
  // /health doubles as the GSLB leader probe; leadership is reported so the
  // GSLB / operator can see which DC is active.
  res.json({ status: "ok", role: cfg.role });
});

app.get("/metrics", async (req, res) => {
  const expected = process.env.METRICS_TOKEN;
  if (expected) {
    const auth = req.get("authorization") || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (supplied !== expected) return res.status(401).json({ error: "Unauthorized" });
  }
  const { contentType, body } = await renderMetrics();
  res.setHeader("Content-Type", contentType);
  res.send(body);
});

// API responses are session/state-dependent — never cache.
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/v1", router);
app.use(errorHandler);

export async function startApp(): Promise<void> {
  // Schedulers + enforcement scheduling run ONLY on the leader. web/all contend
  // for the advisory lock; a standby web stays read-mostly until it wins the
  // lock after a DB promotion.
  if (cfg.runsSchedulers) {
    await startLeaderElection({
      onAcquire: () => void startSchedulers(cfg),
      onLose: () => stopSchedulers(),
    });
  }

  // Per-role pg-boss consumers (filled in by later milestones).
  await startConsumers(cfg);

  registerShutdown();

  if (!BINDS_PUBLIC_LISTENER) {
    // enforcer/worker: optional metrics-only listener; consumers keep the loop alive.
    const rawPort = Number.parseInt(process.env.CHARON_METRICS_PORT ?? "", 10);
    if (Number.isFinite(rawPort) && rawPort > 0) {
      const bind = process.env.CHARON_METRICS_BIND || "127.0.0.1";
      const { startMetricsOnlyServer } = await import("./utils/metricsServer.js");
      await startMetricsOnlyServer(rawPort, bind).catch((err) =>
        logger.error({ err: err?.message }, "metrics-only listener failed"),
      );
    }
    logger.info({ role: cfg.role }, "Non-HTTP role — running consumers only");
    return;
  }

  // App processes listen on localhost HTTP; nginx terminates TLS (PQC-hybrid)
  // and proxies to the web + endpoint upstreams.
  const PORT = Number.parseInt(process.env.PORT ?? "3000", 10) || 3000;
  const bind = process.env.CHARON_BIND || "127.0.0.1";
  const httpServer = app.listen(PORT, bind, () => logger.info({ port: PORT, bind, role: cfg.role }, "Charon listening"));

  // Agent telemetry WebSocket lives on the same listener — nginx routes the
  // /api/v1/agents/ws upgrade to the endpoint upstream. Only attach where this
  // process actually serves agent comms (endpoint / all).
  if (cfg.runsAgentComms) {
    const { attachAgentWsUpgradeHandler } = await import("./api/routes/agentsWs.js");
    attachAgentWsUpgradeHandler(httpServer);
  }
}

// ─── Scheduler / consumer wiring (extension points) ─────────────────────────────
// Filled in by later milestones; kept as gated stubs so the role/leader plumbing
// is exercised from day one.

function startSchedulers(cfg: RoleConfig): void {
  logger.info({ role: cfg.role }, "Leader — schedulers enabled");
  // Health-check sweep: enqueue every 10 min for the worker role to drain.
  void import("./jobs/integrationHealthCheck.js").then((m) => m.scheduleHealthChecks());
  // TODO(milestones 4–6): directory-sync, tag-reconcile, posture-eval producers.
}

function stopSchedulers(): void {
  logger.info("Schedulers paused (lost leadership)");
  void import("./jobs/integrationHealthCheck.js").then((m) => m.stopHealthChecks());
}

async function startConsumers(cfg: RoleConfig): Promise<void> {
  if (cfg.runsWorkers) {
    logger.info("Worker role — directory-sync / tag-reconcile / posture-eval / health-check consumers");
    const m = await import("./jobs/integrationHealthCheck.js");
    await m.registerHealthCheckConsumer().catch((err) =>
      logger.warn({ err: err?.message }, "health-check consumer registration failed"),
    );
    const tr = await import("./jobs/tagReconcileJob.js");
    await tr.registerTagReconcileConsumer().catch((err) =>
      logger.warn({ err: err?.message }, "tag-reconcile consumer registration failed"),
    );
    // TODO(milestone 5): boss.work(QUEUES.postureEval / directorySync).
  }
  if (cfg.runsEnforcement) {
    logger.info("Enforcer role — enforcement-sync consumer");
    const e = await import("./jobs/enforcementSyncJob.js");
    await e.registerEnforcementConsumer().catch((err) =>
      logger.warn({ err: err?.message }, "enforcement-sync consumer registration failed"),
    );
  }
}

function registerShutdown(): void {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      Promise.allSettled([stopLeaderElection(), stopBoss()]).finally(() => process.exit(0));
    });
  }
}

export { app };
