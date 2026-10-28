import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { agentLoginLimiter, adminActionLimiter } from "../../src/api/middleware/rateLimits.js";

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
