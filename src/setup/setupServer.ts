/**
 * src/setup/setupServer.ts — Minimal Express server for first-run setup.
 *
 * Runs instead of the normal app when DATABASE_URL is not configured. Serves
 * setup.html + the setup API only. Only the web/all role reaches here (index.ts
 * gates the worker roles on a configured DB).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import setupRoutes from "./setupRoutes.js";
import { makeRateLimiter } from "../api/middleware/rateLimits.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startSetupServer(): void {
  const app = express();
  app.use(express.json());

  app.use(
    makeRateLimiter({
      windowMs: 5 * 60 * 1000,
      max: 600,
      message: "Too many requests to the setup server — retry shortly.",
    }),
  );

  const publicDir = path.resolve(__dirname, "..", "..", "public");

  app.use("/api/setup", setupRoutes);

  // Redirect any HTML page to setup.html so operators don't land on a
  // half-functional app screen while DATABASE_URL is unset.
  app.get(/\.html$/, (req, res, next) => {
    if (req.path === "/setup.html") return next();
    return res.redirect(302, "/setup.html");
  });

  app.use(express.static(publicDir, { index: false }));

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    res.sendFile(path.join(publicDir, "setup.html"));
  });

  const PORT = Number.parseInt(process.env.PORT ?? "3000", 10) || 3000;
  app.listen(PORT, () => {
    console.log("");
    console.log("  ┌─────────────────────────────────────────────┐");
    console.log("  │   Charon — First-Run Setup                  │");
    console.log(`  │   Open  http://localhost:${PORT}/setup.html      │`);
    console.log("  │   to configure the application.             │");
    console.log("  └─────────────────────────────────────────────┘");
    console.log("");
  });
}
