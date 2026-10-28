/**
 * tests/unit/agentBinaryRoute.test.ts — the PUBLIC installer download is
 * reachable without an agent bearer (it is mounted before the bearer-guarded
 * /agents router) and serves manifest files only.
 */

import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// A real file to serve (vitest runs from the repo root).
const SELF = vi.hoisted(() => `${process.cwd()}/package.json`);

vi.mock("../../src/services/agentDistService.js", () => ({
  resolveInstaller: (f: string) => (f === "ok.msi" ? SELF : null),
}));

import agentBinaryRouter from "../../src/api/routes/agentBinary.js";

describe("GET /agents/binary/:file", () => {
  const app = express();
  app.use("/agents/binary", agentBinaryRouter);
  app.use("/agents", (_req, res) => { res.status(401).json({ error: "bearer router reached" }); });

  it("answers 404 for a file not in the manifest — without falling through to the bearer router", async () => {
    const res = await request(app).get("/agents/binary/nope.msi");
    expect(res.status).toBe(404);
  });

  it("serves a manifest file", async () => {
    const res = await request(app).get("/agents/binary/ok.msi");
    expect(res.status).toBe(200);
  });
});
