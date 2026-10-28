/**
 * tests/integration/tlsPinnedDispatcher.test.ts — business rule 113(e)-(f).
 *
 * `tlsFetch(url, init, false)` — every FortiOS / FortiManager request with
 * SSL verification off — used to send its bearer token to whatever answered.
 * It now pins the certificate per host:port (2026-10-14, re-scan F10/F66):
 * first use pins, a changed certificate is refused BEFORE the request is
 * written and remembered on the pin, an administrator trusts exactly that
 * certificate, and Polaris re-pins by itself inside the window it opens after
 * its own firmware upgrade.
 *
 * Real HTTPS over loopback with the two throwaway fixture certificates, and a
 * real database (skips without one; see _helpers.ts).
 *
 * Charon: polaris's route cases (the asset Sources tab, Trust new certificate)
 * are dropped here; the trust route is pinned with the pin-store routes.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:https";
import { tlsPinA, tlsPinB } from "../helpers/tlsFixtures.js";
import { X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { tlsFetch } from "../../src/utils/tlsDispatcher.js";
import {
  _resetCaches, trustPendingCert, allowRepin, normalizeFingerprint, changedCertPins,
} from "../../src/services/tlsCertPinService.js";

const d = dbDescribe;
const certA = tlsPinA;
const certB = tlsPinB;
const fpA = normalizeFingerprint(new X509Certificate(certA.cert).fingerprint256);
const fpB = normalizeFingerprint(new X509Certificate(certB.cert).fingerprint256);

let server: Server | null = null;
let port = 0;
let requests = 0;

async function serve(cert: typeof certA): Promise<void> {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = createServer(cert, (_req, res) => { requests++; res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  // closeAllConnections on the old server is not enough for undici's pool:
  // keep-alive sockets to the old certificate must not be reused.
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", () => r()));
  port = (server!.address() as AddressInfo).port;
}

async function call(): Promise<{ ok: boolean; code?: string }> {
  try {
    const res = await tlsFetch(`https://127.0.0.1:${port}/api/v2/monitor/system/status`, {
      method: "GET", headers: { Authorization: "Bearer not-a-real-token", Connection: "close" },
    }, false);
    await res.text();
    return { ok: res.ok };
  } catch (err: any) {
    return { ok: false, code: err?.cause?.code };
  }
}

const pin = () => prisma.tlsCertPin.findUnique({ where: { host_port: { host: "127.0.0.1", port } } });

beforeAll(async () => {
  if (!dbReachable) return;
  await serve(certA);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (!dbReachable) return;
  await prisma.tlsCertPin.deleteMany({ where: { host: "127.0.0.1", port } });
});

d("tlsFetch with verifySsl off pins the certificate", () => {
  it("pins on first use and carries the request", async () => {
    _resetCaches();
    expect((await call()).ok).toBe(true);
    expect((await pin())!.fingerprint).toBe(fpA);
  });

  it("refuses a changed certificate before writing the request, and records it", async () => {
    await serve(certB);
    _resetCaches();
    const before = requests;
    const r = await call();
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CERT_PIN_REFUSED");
    expect(requests).toBe(before); // nothing reached the server
    const row = await pin();
    expect(row!.fingerprint).toBe(fpA);
    expect(row!.pendingFingerprint).toBe(fpB);
    expect((await changedCertPins()).some((p) => p.port === port)).toBe(true);
    // A second refusal does not write another mismatch Event.
    const events = await prisma.event.count({ where: { action: "tls.cert.mismatch", resourceName: `127.0.0.1:${port}` } });
    await call();
    expect(await prisma.event.count({ where: { action: "tls.cert.mismatch", resourceName: `127.0.0.1:${port}` } })).toBe(events);
  });

  it("trusts exactly the certificate an administrator inspected", async () => {
    const row = await pin();
    await expect(trustPendingCert(row!.id, fpA, "test-admin")).rejects.toThrow(/different certificate/);
    await trustPendingCert(row!.id, fpB, "test-admin");
    // Also proves a second full handshake still presents a certificate (no
    // TLS session resumption on the pinned connector).
    expect(await call()).toEqual({ ok: true });
    const after = await pin();
    expect(after!.fingerprint).toBe(fpB);
    expect(after!.pendingFingerprint).toBeNull();
  });

  it("re-pins by itself inside the window a Polaris firmware upgrade opens", async () => {
    expect(await allowRepin("127.0.0.1", [port], 5, "system:firmware")).toBe(1);
    await serve(certA);
    _resetCaches();
    expect((await call()).ok).toBe(true);
    const row = await pin();
    expect(row!.fingerprint).toBe(fpA);
    // The window stays open after the first re-pin (rule 113(g)).
    expect(row!.repinUntil).not.toBeNull();
  });

  it("re-pins a SECOND change inside the same window (a gate that changes its cert twice while booting)", async () => {
    const repinned = () => prisma.event.count({ where: { action: "tls.cert.repinned", resourceName: `127.0.0.1:${port}` } });
    const before = await repinned();
    // No cache reset: a cached mismatch must still reach the window check.
    await serve(certB);
    expect((await call()).ok).toBe(true);
    const row = await pin();
    expect(row!.fingerprint).toBe(fpB);
    expect(row!.pendingFingerprint).toBeNull();
    expect(await repinned()).toBe(before + 1);
  });

  it("refuses a change once the window has expired, and keeps the last re-pinned certificate", async () => {
    const row = await pin();
    await prisma.tlsCertPin.update({ where: { id: row!.id }, data: { repinUntil: new Date(Date.now() - 1000) } });
    _resetCaches();
    await serve(certA);
    expect((await call()).ok).toBe(false);
    const after = await pin();
    expect(after!.fingerprint).toBe(fpB);
    expect(after!.pendingFingerprint).toBe(fpA);
    // Leave the state the route cases below start from: certificate A pinned, nothing pending.
    await prisma.tlsCertPin.update({ where: { id: after!.id }, data: { fingerprint: fpA, pendingFingerprint: null, pendingSubject: null, pendingSeenAt: null, repinUntil: null } });
    _resetCaches();
  });
});
