/**
 * src/utils/metricsServer.ts — Standalone /metrics + /health listener for the
 * non-HTTP roles (enforcer, worker).
 *
 * web/all + endpoint serve /metrics from the main Express app; enforcer/worker
 * have no inbound app listener, so without this their metrics live in a process
 * Prometheus never scrapes. Gated on CHARON_METRICS_PORT being set.
 */

import express from "express";
import { renderMetrics } from "../metrics.js";
import { logger } from "./logger.js";

export async function startMetricsOnlyServer(port: number, bind: string): Promise<void> {
  const app = express();

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

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

  await new Promise<void>((resolve) => {
    app.listen(port, bind, () => {
      logger.info({ port, bind }, "Metrics-only listener started");
      resolve();
    });
  });
}
