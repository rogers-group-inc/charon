/**
 * src/services/agentChannelService.ts — agent WebSocket session manager.
 *
 * Ported from polaris (keyed by Endpoint id instead of ManagedAgent id). Holds
 * the in-memory map of `endpointId → WebSocket` for every agent attached to
 * THIS process and the verbs the rest of Charon uses to push frames at them:
 *
 *  - `attach(endpointId, ws)` — register, send `hello`, start the 30 s ping,
 *    stamp `wsConnectedAt`. The newest attach for an endpoint wins (the old
 *    socket is closed): an agent that redials during a restart's reconnect herd
 *    keeps ONE live session.
 *  - `detach(endpointId, reason, only?)` — scoped to one session: a replaced
 *    socket's late close must not tear down its live replacement.
 *  - `refreshConfig(endpointId)` — a `refresh-config` frame: the agent
 *    re-fetches GET /agents/config now (new cert pins during a rotation, a
 *    changed login mode) instead of on its next poll.
 *
 * Frame envelope: { "type": "<verb>", "id": "", "payload": {...} }.
 * Inbound frames are the agent's heartbeat / posture (handled by the caller's
 * `onFrame` callback, agentsWs.ts). A frame that throws closes THAT socket,
 * never the process.
 *
 * Cross-process: the agent may be attached to another process (the
 * `endpoint` role) than the one that changed something (the `web` role).
 * `publishConfigRefresh()` sends a Postgres NOTIFY on CFG_REFRESH_CHANNEL; every
 * process holding sessions LISTENs (`startConfigRefreshListener()`) and
 * forwards it to its own sockets. Best-effort — the agent's /config poll is the
 * guaranteed floor. LISTEN needs a session-pinned connection, so it uses the
 * DIRECT database URL (a transaction pooler would drop it).
 */

import type { WebSocket } from "ws";
import pg from "pg";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Postgres NOTIFY channel. Payload: a comma-separated endpoint id list (push
 * refresh-config), "*" (refresh every attached agent), or "revoke:<ids>"
 * (close those endpoints' sockets).
 */
export const CFG_REFRESH_CHANNEL = "charon_agent_cfg_refresh";

export interface Session {
  ws: WebSocket;
  attachedAt: number;
  pingTimer: NodeJS.Timeout | null;
  pongSeen: boolean;
}

const sessions = new Map<string, Session>();

export type FrameHandler = (endpointId: string, frame: Frame) => Promise<void> | void;

export interface Frame {
  type: string;
  id: string;
  payload: unknown;
}

/** A parsed frame is agent-controlled JSON: `null`, a number or an array parse fine. */
export function asFrame(value: unknown): Frame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string") return null;
  // Charon's agent sends flat frames ({type, posture, ip…}); keep the whole object as the payload.
  return { type: v.type, id: typeof v.id === "string" ? v.id : "", payload: "payload" in v ? v.payload : v };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function attach(endpointId: string, ws: WebSocket, onFrame: FrameHandler): void {
  // A socket that is no longer OPEN is an attempt the agent already abandoned
  // and has since redialed — registering it would displace the live retry.
  // 1 = WebSocket.OPEN (ws is a type-only import).
  if (ws.readyState !== 1) {
    try { ws.terminate(); } catch { /* already gone */ }
    return;
  }
  const existing = sessions.get(endpointId);
  if (existing) teardown(existing);

  const session: Session = { ws, attachedAt: Date.now(), pingTimer: null, pongSeen: true };
  sessions.set(endpointId, session);
  safeSend(ws, { type: "hello", id: "", payload: { endpointId } });

  ws.on("message", (data) => {
    let frame: Frame | null;
    try {
      const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
      frame = asFrame(JSON.parse(text));
    } catch (err) {
      logger.warn({ err, endpointId }, "Agent WS frame parse failed; closing the socket");
      detach(endpointId, "malformed frame", session);
      return;
    }
    if (!frame) return;
    Promise.resolve()
      .then(() => onFrame(endpointId, frame!))
      .catch((err) => logger.warn({ err: err?.message, endpointId }, "agent WS frame failed"));
  });
  ws.on("pong", () => { session.pongSeen = true; });
  ws.on("close", () => detach(endpointId, "socket closed", session));
  ws.on("error", (err) => {
    logger.warn({ err: err?.message, endpointId }, "agent WS error");
    detach(endpointId, "socket error", session);
  });

  session.pingTimer = setInterval(() => {
    if (!session.pongSeen) {
      detach(endpointId, "heartbeat timeout", session);
      return;
    }
    session.pongSeen = false;
    try { ws.ping(); } catch { /* the close handler does its job */ }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof session.pingTimer.unref === "function") session.pingTimer.unref();
}

/**
 * `only` scopes the detach to one session: when the map already holds a
 * different one (this socket was replaced), nothing is torn down.
 */
export function detach(endpointId: string, reason: string, only?: Session): boolean {
  const session = sessions.get(endpointId);
  if (!session) return false;
  if (only && session !== only) return false;
  sessions.delete(endpointId);
  teardown(session);
  logger.debug({ endpointId, reason }, "agent WS detached");
  return true;
}

function teardown(session: Session): void {
  if (session.pingTimer) clearInterval(session.pingTimer);
  try { session.ws.close(); } catch { /* already closed */ }
}

export function isAttached(endpointId: string): boolean {
  return sessions.has(endpointId);
}

export function liveSessionCount(): number {
  return sessions.size;
}

// ─── Server-initiated verbs ─────────────────────────────────────────────────

export function refreshConfig(endpointId: string): boolean {
  const session = sessions.get(endpointId);
  if (!session) return false;
  safeSend(session.ws, { type: "refresh-config", id: "", payload: {} });
  return true;
}

/** Push refresh-config to every agent attached to this process. */
export function refreshAllConfigs(): number {
  let n = 0;
  for (const id of sessions.keys()) if (refreshConfig(id)) n++;
  return n;
}

/** Close an endpoint's live socket (bearer revoked). */
export function disconnect(endpointId: string, reason: string): boolean {
  return detach(endpointId, reason);
}

function safeSend(ws: WebSocket, frame: unknown): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    logger.warn({ err }, "Agent WS send failed");
  }
}

// ─── Cross-process config refresh (NOTIFY / LISTEN) ─────────────────────────

/**
 * Ask every process holding agent sessions to push refresh-config: to the given
 * endpoints, or to ALL attached agents when `endpointIds` is "*". Applies
 * locally at once (single-process installs), then NOTIFYs the others.
 * Best-effort; never throws.
 */
export async function publishConfigRefresh(endpointIds: readonly string[] | "*"): Promise<void> {
  const payload = endpointIds === "*" ? "*" : endpointIds.filter(Boolean).join(",");
  if (!payload) return;
  if (payload === "*") refreshAllConfigs(); else for (const id of payload.split(",")) refreshConfig(id);
  try {
    // NOTIFY payloads cap at 8000 bytes; a long id list is chunked.
    const chunks = payload === "*" ? ["*"] : chunkIds(payload.split(","), 7000);
    for (const c of chunks) await prisma.$executeRaw`SELECT pg_notify(${CFG_REFRESH_CHANNEL}, ${c})`;
  } catch (err) {
    logger.debug({ err }, "agent config-refresh NOTIFY failed (agents still poll /config)");
  }
}

/**
 * Close the live socket of revoked endpoints in every process (rule 4: a
 * revoked bearer is locked out of WS as well as HTTP — the bearer is only
 * checked at upgrade, so an open socket would otherwise outlive the revoke).
 */
export async function publishDisconnect(endpointIds: readonly string[]): Promise<void> {
  const ids = endpointIds.filter(Boolean);
  if (!ids.length) return;
  for (const id of ids) disconnect(id, "revoked");
  try {
    for (const c of chunkIds(ids, 7000)) await prisma.$executeRaw`SELECT pg_notify(${CFG_REFRESH_CHANNEL}, ${`revoke:${c}`})`;
  } catch (err) {
    logger.debug({ err }, "agent disconnect NOTIFY failed");
  }
}

function chunkIds(ids: string[], maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const id of ids) {
    if (cur && cur.length + id.length + 1 > maxBytes) { out.push(cur); cur = ""; }
    cur = cur ? `${cur},${id}` : id;
  }
  if (cur) out.push(cur);
  return out;
}

let listenClient: pg.Client | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let listenerStopped = false;

/** Start LISTENing (processes that attach agent sockets: runsAgentComms). */
export async function startConfigRefreshListener(): Promise<void> {
  listenerStopped = false;
  await connectListener();
}

async function connectListener(): Promise<void> {
  if (listenerStopped) return;
  const url = process.env.CHARON_DB_DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    logger.warn("Agent config-refresh listener: no database URL — agents pick up changes on their /config poll");
    return;
  }
  const client = new pg.Client({ connectionString: url });
  client.on("notification", (msg) => {
    if (msg.channel !== CFG_REFRESH_CHANNEL || !msg.payload) return;
    if (msg.payload === "*") { refreshAllConfigs(); return; }
    if (msg.payload.startsWith("revoke:")) {
      for (const id of msg.payload.slice("revoke:".length).split(",")) if (id) disconnect(id, "revoked");
      return;
    }
    for (const id of msg.payload.split(",")) if (id) refreshConfig(id);
  });
  client.on("error", (err) => {
    logger.warn({ err: err.message }, "Agent config-refresh listener error — reconnecting");
    scheduleReconnect();
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CFG_REFRESH_CHANNEL}`);
    listenClient = client;
  } catch (err) {
    logger.warn({ err }, "Agent config-refresh listener connect failed — retrying");
    try { await client.end(); } catch { /* ignore */ }
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (listenerStopped || reconnectTimer) return;
  if (listenClient) { try { void listenClient.end(); } catch { /* ignore */ } listenClient = null; }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectListener();
  }, 5000);
  if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
}

/** Shutdown hook: stop LISTENing and close every session. */
export async function shutdownAllSessions(): Promise<void> {
  listenerStopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (listenClient) { try { await listenClient.end(); } catch { /* ignore */ } listenClient = null; }
  for (const id of Array.from(sessions.keys())) detach(id, "server shutdown");
}
