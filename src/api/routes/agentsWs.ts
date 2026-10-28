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
import { attach, isAttached, startConfigRefreshListener, type Frame } from "../../services/agentChannelService.js";

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

    // The session manager owns the socket's lifecycle (ping / pong, replace-on-
    // redial, malformed-frame close) and the server→agent verbs (refresh-config).
    attach(endpointId, ws, handleFrame);

    ws.on("close", () => {
      decAgentWs();
      // A replaced socket's late close must not mark a live endpoint offline.
      if (isAttached(endpointId)) return;
      void prisma.endpoint.update({ where: { id: endpointId }, data: { status: "offline", wsDisconnectedAt: new Date() } }).catch(() => {});
    });
  });

  // Config refreshes published by other processes (pin staging, auth-mode changes).
  void startConfigRefreshListener();
  logger.info({ path: WS_PATH }, "Agent telemetry WebSocket handler attached");
}

async function handleFrame(endpointId: string, frame: Frame): Promise<void> {
  const msg = (frame.payload ?? {}) as Record<string, any>;
  if (frame.type === "heartbeat") {
    await prisma.endpoint.update({
      where: { id: endpointId },
      data: { lastSeenAt: new Date(), currentIp: msg.ip ?? undefined, currentMac: msg.mac ?? undefined },
    });
  } else if (frame.type === "posture" && msg.posture) {
    const { changed } = await ingestPosture(endpointId, msg.posture);
    if (changed) await enqueueReconcile(endpointId);
  }
}
