import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { agentLoginLimiter, adminActionLimiter } from "../../src/api/middleware/rateLimits.js";
import maintenanceRouter, { installerLimiter } from "../../src/api/routes/maintenance.js";
import webServerRouter from "../../src/api/routes/settings/webServer.js";

/** The handler chain Express registered for METHOD PATH on a router. */
function handlersOf(router: express.Router, method: string, path: string): unknown[] {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path} on the router`);
  return layer.route.stack.map((l: any) => l.handle);
}

// Every request arrives from the same IP (supertest → loopback), so these prove
// the buckets are keyed by endpoint / operator rather than by address.
function appWith(limiter: express.RequestHandler, attach: (req: express.Request) => void) {
  const app = express();
  app.use((req, _res, next) => { attach(req); next(); });
  app.post("/", limiter, (_req, res) => { res.json({ ok: true }); });
  return app;
}

async function hit(app: express.Express, header: string, n: number) {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await request(app).post("/").set("x-who", header)).status);
  return codes;
}

describe("agentLoginLimiter", () => {
  it("throttles one endpoint without locking out another behind the same IP", async () => {
    const app = appWith(agentLoginLimiter, (req) => { req.agent = { endpointId: String(req.headers["x-who"]) }; });
    const a = await hit(app, "ep-a", 11);
    expect(a.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(a[10]).toBe(429);
    expect((await hit(app, "ep-b", 1))[0]).toBe(200);
  });
});

describe("adminActionLimiter", () => {
  it("throttles per operator, not per shared address", async () => {
    const app = appWith(adminActionLimiter, (req) => { (req as any).session = { username: String(req.headers["x-who"]) }; });
    const alice = await hit(app, "alice", 21);
    expect(alice.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(alice[20]).toBe(429);
    expect((await hit(app, "bob", 1))[0]).toBe(200);
  });
});

// CodeQL js/missing-rate-limiting: a route move or port must not drop these.
describe("limiter attachment", () => {
  it("rate-limits the installer listing and download", () => {
    expect(handlersOf(maintenanceRouter, "get", "/agents")).toContain(installerLimiter);
    expect(handlersOf(maintenanceRouter, "get", "/agents/download/:file")).toContain(installerLimiter);
  });

  it("rate-limits the local-login source scope ahead of its permission check", () => {
    const chain = handlersOf(webServerRouter, "put", "/login-access");
    expect(chain[0]).toBe(adminActionLimiter);
  });
});
