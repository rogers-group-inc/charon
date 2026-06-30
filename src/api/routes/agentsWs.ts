/**
 * src/api/routes/agentsWs.ts — Agent telemetry WebSocket.
 *
 * Persistent agent connection at /api/v1/agents/ws. The agent presents its
 * bearer in the `Sec-WebSocket-Protocol` header (subprotocol form
 * "bearer.<token>") since browsers/WS clients can't set Authorization on the
 * upgrade. We verify it, mark the endpoint online, and accept periodic
 * heartbeat/posture frames. Disconnect marks the endpoint offline.
 *
 * Mounted only on processes that bind the public listener AND run agent comms
 * (endpoint / all). nginx proxies the upgrade with long timeouts.
 */

import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyBearer } from "../../services/agentTokenService.js";
import { ingestPosture } from "../../services/postureService.js";
import { enqueueReconcile } from "../../jobs/tagReconcileJob.js";
import { prisma } from "../../db.js";
import { logger } from "../../utils/logger.js";
import { incAgentWs, decAgentWs } from "../../metrics.js";

const WS_PATH = "/api/v1/agents/ws";

function extractBearerFromProtocol(header: string | undefined): string | null {
  if (!header) return null;
  // Comma-separated subprotocols; we use "bearer.<token>".
  for (const part of header.split(",").map((s) => s.trim())) {
    if (part.startsWith("bearer.")) return part.slice("bearer.".length);
  }
  return null;
}

export function attachAgentWsUpgradeHandler(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith(WS_PATH)) return; // not ours — leave for other handlers
    const token = extractBearerFromProtocol(req.headers["sec-websocket-protocol"] as string | undefined);
    const callerIp = (req.socket.remoteAddress || null) ?? null;
    void (async () => {
      const verified = token ? await verifyBearer(token, callerIp) : null;
      if (!verified) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, verified.endpointId);
      });
    })();
  });

  wss.on("connection", (ws: WebSocket, _req: unknown, endpointId: string) => {
    incAgentWs();
    const now = new Date();
    void prisma.endpoint.update({ where: { id: endpointId }, data: { status: "online", wsConnectedAt: now, lastSeenAt: now } }).catch(() => {});

    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      void handleFrame(endpointId, msg).catch((err) => logger.warn({ err: err?.message, endpointId }, "agent WS frame failed"));
    });

    ws.on("close", () => {
      decAgentWs();
      void prisma.endpoint.update({ where: { id: endpointId }, data: { status: "offline", wsDisconnectedAt: new Date() } }).catch(() => {});
    });

    ws.on("error", (err) => logger.warn({ err: err?.message, endpointId }, "agent WS error"));
  });

  logger.info({ path: WS_PATH }, "Agent telemetry WebSocket handler attached");
}

async function handleFrame(endpointId: string, msg: any): Promise<void> {
  if (msg?.type === "heartbeat") {
    await prisma.endpoint.update({
      where: { id: endpointId },
      data: { lastSeenAt: new Date(), currentIp: msg.ip ?? undefined, currentMac: msg.mac ?? undefined },
    });
  } else if (msg?.type === "posture" && msg.posture) {
    const { changed } = await ingestPosture(endpointId, msg.posture);
    if (changed) await enqueueReconcile(endpointId);
  }
}
