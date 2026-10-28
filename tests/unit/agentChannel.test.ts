/**
 * tests/unit/agentChannel.test.ts — the agent WS session manager
 * (services/agentChannelService.ts) and the silence cutoff
 * (utils/agentSilence.ts).
 *
 * Session pins (from polaris's channel incidents): the newest attach wins; a
 * replaced socket's late close never tears down its live replacement; a frame
 * that is not JSON closes only that socket; refresh-config reaches only
 * attached agents.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../../src/db.js", () => ({ prisma: { $executeRaw: vi.fn(async () => 0) } }));

import {
  attach, detach, isAttached, refreshConfig, refreshAllConfigs, asFrame, liveSessionCount, publishDisconnect,
} from "../../src/services/agentChannelService.js";
import { silenceWindowMs, silenceCutoff } from "../../src/utils/agentSilence.js";

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
  ping() {}
}

const noop = () => {};

describe("agent channel sessions", () => {
  it("sends hello on attach and refresh-config on request", () => {
    const ws = new FakeWs();
    attach("ep-1", ws as any, noop);
    expect(ws.sent[0]).toMatchObject({ type: "hello", payload: { endpointId: "ep-1" } });
    expect(refreshConfig("ep-1")).toBe(true);
    expect(ws.sent.at(-1)).toMatchObject({ type: "refresh-config" });
    expect(refreshConfig("not-attached")).toBe(false);
    detach("ep-1", "test");
  });

  it("the newest attach wins and the old socket's late close does not detach it", () => {
    const a = new FakeWs();
    const b = new FakeWs();
    attach("ep-2", a as any, noop);
    attach("ep-2", b as any, noop);
    expect(a.closed).toBe(true);
    a.emit("close");
    expect(isAttached("ep-2")).toBe(true);
    b.emit("close");
    expect(isAttached("ep-2")).toBe(false);
  });

  it("drops a socket that closed before it could attach", () => {
    const ws = new FakeWs();
    ws.readyState = 3;
    attach("ep-3", ws as any, noop);
    expect(isAttached("ep-3")).toBe(false);
  });

  it("closes only the socket that sent a non-JSON frame", () => {
    const good = new FakeWs();
    const bad = new FakeWs();
    attach("ep-good", good as any, noop);
    attach("ep-bad", bad as any, noop);
    bad.emit("message", Buffer.from("{not json"));
    expect(isAttached("ep-bad")).toBe(false);
    expect(isAttached("ep-good")).toBe(true);
    detach("ep-good", "test");
  });

  it("dispatches parsed frames, flat or enveloped", async () => {
    const seen: any[] = [];
    const ws = new FakeWs();
    attach("ep-4", ws as any, (_id, f) => { seen.push(f); });
    ws.emit("message", Buffer.from(JSON.stringify({ type: "heartbeat", ip: "10.0.0.9" })));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0]).toMatchObject({ type: "heartbeat", payload: { ip: "10.0.0.9" } });
    expect(asFrame([1, 2])).toBeNull();
    expect(asFrame({ type: "x", payload: { a: 1 } })).toEqual({ type: "x", id: "", payload: { a: 1 } });
    detach("ep-4", "test");
  });

  it("refresh-all reaches every attached agent; a revoke disconnects", async () => {
    const x = new FakeWs();
    const y = new FakeWs();
    attach("ep-x", x as any, noop);
    attach("ep-y", y as any, noop);
    expect(refreshAllConfigs()).toBe(2);
    await publishDisconnect(["ep-x"]);
    expect(isAttached("ep-x")).toBe(false);
    expect(x.closed).toBe(true);
    expect(liveSessionCount()).toBe(1);
    detach("ep-y", "test");
  });
});

describe("agent silence cutoff", () => {
  const now = 10_000_000;
  it("is two intervals, never under interval + 60 s", () => {
    expect(silenceWindowMs(60)).toBe(120_000);
    expect(silenceWindowMs(10)).toBe(70_000);
  });

  it("judges nobody before this process has listened a whole window", () => {
    expect(silenceCutoff({ now, listeningSince: now - 60_000, intervalSeconds: 60, newestSeenAt: new Date(now), reportingCount: 5 }).cutoff).toBeNull();
  });

  it("abstains when the whole fleet is dark (Charon not receiving)", () => {
    const r = silenceCutoff({ now, listeningSince: 0, intervalSeconds: 60, newestSeenAt: new Date(now - 600_000), reportingCount: 5 });
    expect(r).toEqual({ cutoff: null, fleetDark: true });
  });

  it("a fleet of one cannot tell the two apart, so it is judged", () => {
    const r = silenceCutoff({ now, listeningSince: 0, intervalSeconds: 60, newestSeenAt: new Date(now - 600_000), reportingCount: 1 });
    expect(r.cutoff!.getTime()).toBe(now - 120_000);
  });

  it("never sets the cutoff before listeningSince", () => {
    const since = now - 130_000;
    const r = silenceCutoff({ now, listeningSince: since, intervalSeconds: 60, newestSeenAt: new Date(now), reportingCount: 3 });
    expect(r.cutoff!.getTime()).toBe(now - 120_000);
    expect(r.cutoff!.getTime()).toBeGreaterThanOrEqual(since);
  });
});
