/**
 * src/services/credentials/credentialProbeService.ts — the one-shot probes
 * behind Server Settings → Credentials (Test Connection) and the MIB Browse
 * walk. Ported from polaris src/services/monitoringService.ts
 * (probeCredentialAgainstHost, probeSnmp / probeWinRm / probeSsh /
 * probeRestApiCredential / probeHttp, buildSnmpSession, snmpWalkRaw) — the
 * transport code is verbatim apart from:
 *
 *   - no per-host SNMP gate / phase tracing / ICMP (monitor-only machinery);
 *   - trust-on-first-use pinning (polaris business rule 113 — SSH host keys,
 *     and the TLS certificate of any HTTPS endpoint a secret is sent to
 *     without a CA check) is kept, but pins live in Charon's Setting table
 *     under `credentials.pin.<ssh|tls>:<host>:<port>` instead of polaris's
 *     SshHostKey / TlsCertPin tables. A mismatch refuses BEFORE any secret is
 *     written and logs a warning Event; re-trusting a legitimately re-keyed
 *     host means deleting that Setting row.
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { request as httpsRequest, Agent as HttpsAgent, type AgentOptions } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as tlsConnect, type PeerCertificate, type ConnectionOptions } from "node:tls";
import type { Duplex } from "node:stream";
import type { LookupFunction } from "node:net";
import * as snmp from "net-snmp";
import { Client as SshClient } from "ssh2";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { logEvent } from "../eventService.js";
import { trimTrailing } from "./trimTrailing.js";
import { bareHost, isIpv6Address, urlHost } from "./cidr.js";
import { makeOidMonotonicGuard } from "./oidCompare.js";
import {
  type HttpAuthConfig,
  type HttpCheckConfig,
  type HttpProbeDiagnostics,
  MAX_BODY_BYTES,
  bodyExcerpt,
  describeHttpTarget,
  evaluateHttpCheck,
  resolveHttpTarget,
  resolveHttpAuthMode,
} from "./httpCheck.js";
import { parseDigestChallenge, buildDigestAuthorization, authSchemesOffered, newCnonce } from "./digestAuth.js";

export interface ProbeResult {
  success: boolean;
  /** Wall-clock duration of the probe, rounded to integer ms. */
  responseTimeMs: number;
  /** Short human-readable reason on failure. */
  error?: string;
}

/** polaris HARDCODED_FLOOR.probeTimeoutMs — the operator-driven test default. */
export const PROBE_TIMEOUT_MS = 5000;
/** polaris COLLECTOR_REQUEST_TIMEOUT_MS — per-request timeout for a walk. */
const COLLECTOR_REQUEST_TIMEOUT_MS = 10_000;
/** polaris SNMP_WALK_HARD_MAX. */
export const SNMP_WALK_HARD_MAX = 5000;
const sysUpTimeOid = "1.3.6.1.2.1.1.3.0";

function finish(startedAt: number, success: boolean, error?: string): ProbeResult {
  const r: ProbeResult = { success, responseTimeMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  if (!success) r.error = error || "Probe failed";
  return r;
}

function toPositiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

// ─── Trust-on-first-use pins (Setting-backed) ────────────────────────────────

type PinKind = "ssh" | "tls";
type PinVerdict = { ok: true } | { ok: false; expected: string; actual: string };

function pinKey(kind: PinKind, host: string, port: number): string {
  return `credentials.pin.${kind}:${host}:${port}`;
}

/** no pin → store + accept; match → accept; differ → refuse + warning Event. Exported for tests. */
export async function verifyOrPin(kind: PinKind, host: string, port: number, fingerprint: string, detail = ""): Promise<PinVerdict> {
  const key = pinKey(kind, host, port);
  const read = async () => {
    const row = await prisma.setting.findUnique({ where: { key } });
    const v = row?.value as { fingerprint?: unknown } | undefined;
    return typeof v?.fingerprint === "string" ? v.fingerprint : null;
  };
  let pinned = await read();
  if (pinned === null) {
    try {
      await prisma.setting.create({
        data: { key, value: { fingerprint, detail: detail.slice(0, 200), pinnedAt: new Date().toISOString() } },
      });
      void logEvent({
        action: kind === "ssh" ? "ssh.host_key.pinned" : "tls.cert.pinned",
        resourceType: kind === "ssh" ? "ssh-host-key" : "tls-cert-pin",
        resourceName: `${host}:${port}`,
        actor: "system:credentials",
        message: `Pinned ${kind === "ssh" ? "SSH host key" : "TLS certificate"} for ${host}:${port}${detail ? ` (${detail})` : ""}`,
        details: { host, port, fingerprint },
      });
      return { ok: true };
    } catch {
      // Concurrent first contact raced on the key; whoever won must agree.
      pinned = await read();
      if (pinned === null) throw new AppError(500, "Could not record the server identity pin");
    }
  }
  if (pinned === fingerprint) return { ok: true };
  void logEvent({
    action: kind === "ssh" ? "ssh.host_key.mismatch" : "tls.cert.mismatch",
    resourceType: kind === "ssh" ? "ssh-host-key" : "tls-cert-pin",
    resourceName: `${host}:${port}`,
    actor: "system:credentials",
    level: "warning",
    message:
      `${kind === "ssh" ? "SSH host key" : "TLS certificate"} for ${host}:${port} does not match the pinned one — refused before sending any credential. ` +
      `If it was legitimately re-keyed, delete the setting "${key}" to trust the new one.`,
    details: { host, port, expectedFingerprint: pinned, actualFingerprint: fingerprint },
  });
  return { ok: false, expected: pinned, actual: fingerprint };
}

/** OpenSSH-style fingerprint of a raw host-key blob (what `ssh-keygen -lf` prints). */
export function fingerprintKeyBlob(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

/** ssh2 hostVerifier — on unless verifyHostKey is false (rule 113). Fails CLOSED. */
function buildHostVerifier(host: string, port: number, config: Record<string, unknown>): ((key: Buffer, cb: (valid: boolean) => void) => void) | null {
  if (config.verifyHostKey === false) return null;
  return (key: Buffer, cb: (valid: boolean) => void) => {
    verifyOrPin("ssh", host, port, fingerprintKeyBlob(key))
      .then((v) => cb(v.ok))
      .catch(() => cb(false));
  };
}

/** The request failed because the server's certificate was refused — no credential was sent. */
export class CertPinRefusedError extends Error {
  readonly code = "CERT_PIN_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "CertPinRefusedError";
  }
}

/**
 * polaris utils/pinnedTlsAgent.ts (verbatim behavior): opens the TLS socket,
 * checks the leaf against the pin AFTER the handshake and BEFORE the request
 * (and its Authorization header) is written. No session resumption, no keep-alive.
 */
class PinnedTlsAgent extends HttpsAgent {
  private readonly check: (cert: PeerCertificate) => Promise<{ ok: true } | { ok: false; reason: string }>;

  constructor(check: (cert: PeerCertificate) => Promise<{ ok: true } | { ok: false; reason: string }>, opts: AgentOptions = {}) {
    super({ ...opts, keepAlive: false, maxCachedSessions: 0 });
    this.check = check;
  }

  createConnection(options: ConnectionOptions, callback?: (err: Error | null, stream: Duplex) => void): Duplex | undefined {
    let settled = false;
    const done = (err: Error | null, socket: Duplex): void => {
      if (settled) return;
      settled = true;
      callback?.(err, socket);
    };
    const socket = tlsConnect({ ...options, rejectUnauthorized: false, session: undefined });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(false);
      if (!cert || !cert.fingerprint256) {
        socket.destroy();
        done(new CertPinRefusedError("The server presented no certificate"), socket);
        return;
      }
      this.check(cert).then(
        (v) => {
          if (v.ok) { done(null, socket); return; }
          socket.destroy();
          done(new CertPinRefusedError(v.reason), socket);
        },
        (err: unknown) => {
          socket.destroy();
          done(new CertPinRefusedError(`Could not check the server certificate: ${err instanceof Error ? err.message : String(err)}`), socket);
        },
      );
    });
    socket.once("error", (err) => done(err, socket));
    return undefined;
  }
}

function pinnedAgentFor(host: string, port: number): PinnedTlsAgent {
  return new PinnedTlsAgent(async (cert) => {
    const subject = typeof cert.subject?.CN === "string" ? cert.subject.CN : "";
    const fp = String(cert.fingerprint256).replace(/:/g, "").toUpperCase();
    const v = await verifyOrPin("tls", host, port, fp, subject);
    return v.ok
      ? { ok: true }
      : { ok: false, reason: `The TLS certificate of ${host}:${port} changed since it was pinned — refused before sending any credential.` };
  });
}

// ─── SNMP ────────────────────────────────────────────────────────────────────

function mapSnmpAuthProtocol(value: unknown): unknown {
  switch (value) {
    case "MD5":    return snmp.AuthProtocols.md5;
    case "SHA":    return snmp.AuthProtocols.sha;
    case "SHA224": return snmp.AuthProtocols.sha224;
    case "SHA256": return snmp.AuthProtocols.sha256;
    case "SHA384": return snmp.AuthProtocols.sha384;
    case "SHA512": return snmp.AuthProtocols.sha512;
    default: throw new AppError(400, `Unsupported SNMP v3 authProtocol "${String(value)}"`);
  }
}

function mapSnmpPrivProtocol(value: unknown): unknown {
  switch (value) {
    case "DES":     return snmp.PrivProtocols.des;
    case "AES":     return snmp.PrivProtocols.aes;
    case "AES256B": return snmp.PrivProtocols.aes256b;
    case "AES256R": return snmp.PrivProtocols.aes256r;
    default: throw new AppError(400, `Unsupported SNMP v3 privProtocol "${String(value)}"`);
  }
}

function buildSnmpSession(host: string, config: Record<string, unknown>, timeoutMs?: number): any {
  const port = toPositiveInt(config.port, 161);
  const version = config.version === "v3" ? "v3" : "v2c";
  const effectiveTimeout = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : COLLECTOR_REQUEST_TIMEOUT_MS;
  const transport = isIpv6Address(host) ? "udp6" : "udp4";
  const s = snmp as any;
  if (version === "v2c") {
    return s.createSession(host, String(config.community || ""), {
      port,
      transport,
      version: s.Version2c,
      timeout: effectiveTimeout,
      retries: 0,
    });
  }
  const securityLevel = config.securityLevel === "noAuthNoPriv"
    ? s.SecurityLevel.noAuthNoPriv
    : config.securityLevel === "authNoPriv"
      ? s.SecurityLevel.authNoPriv
      : s.SecurityLevel.authPriv;
  const user: any = { name: String(config.username || ""), level: securityLevel };
  if (securityLevel !== s.SecurityLevel.noAuthNoPriv) {
    user.authProtocol = mapSnmpAuthProtocol(config.authProtocol);
    user.authKey      = String(config.authKey || "");
  }
  if (securityLevel === s.SecurityLevel.authPriv) {
    user.privProtocol = mapSnmpPrivProtocol(config.privProtocol);
    user.privKey      = String(config.privKey || "");
  }
  return s.createV3Session(host, user, {
    port,
    transport,
    version: s.Version3,
    timeout: effectiveTimeout,
    retries: 0,
  });
}

async function probeSnmp(host: string, config: Record<string, unknown>, timeoutMs: number): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const start = performance.now();
    let resolved = false;
    let session: any;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { session?.close?.(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SNMP timed out")), timeoutMs);
    try {
      session = buildSnmpSession(host, config, timeoutMs);
      session.on("error", (err: Error) => finishOnce(finish(start, false, err?.message || "SNMP error")));
      session.get([sysUpTimeOid], (err: Error | null, varbinds: any[]) => {
        clearTimeout(timer);
        if (err) return finishOnce(finish(start, false, err.message || "SNMP get failed"));
        if (!varbinds || varbinds.length === 0) return finishOnce(finish(start, false, "SNMP returned no varbinds"));
        const vb = varbinds.find((v) => String(v?.oid) === sysUpTimeOid) ?? varbinds[0];
        if ((snmp as any).isVarbindError(vb)) return finishOnce(finish(start, false, (snmp as any).varbindError(vb)));
        finishOnce(finish(start, true));
      });
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SNMP setup failed"));
    }
  });
}

export interface SnmpWalkRow {
  oid: string;
  type: string;
  value: string;
}

export interface SnmpWalkResult {
  rows: SnmpWalkRow[];
  truncated: boolean;
  durationMs: number;
}

function walkLoopError(baseOid: string, prevOid: string, oid: string): AppError {
  return new AppError(
    502,
    `SNMP walk of ${baseOid} aborted: agent returned a non-increasing OID (${oid} after ${prevOid}) — ` +
    `the device's SNMP agent is stuck in a GETNEXT/GETBULK loop instead of advancing. ` +
    `Try an SNMP v1 credential (avoids GETBULK) or a device firmware update.`,
  );
}

function snmpTypeName(t: unknown): string {
  if (typeof t !== "number") return "Unknown";
  return ((snmp as any).ObjectType as Record<number, string>)[t] || `Type(${t})`;
}

/** Printable form of one varbind (polaris snmpVarbindToPrintable). Exported for tests. */
export function snmpVarbindToPrintable(vb: { type: number; value: unknown }): string {
  const t = vb.type;
  const v = vb.value;
  if (v == null) return "";
  if (Buffer.isBuffer(v)) {
    if (t === (snmp as any).ObjectType.IpAddress && v.length === 4) {
      return `${v[0]}.${v[1]}.${v[2]}.${v[3]}`;
    }
    const text = v.toString("utf8");
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) return trimTrailing(text, " ");
    return v.toString("hex").match(/.{1,2}/g)?.join(" ").toUpperCase() || "";
  }
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

/** Operator-facing snmpwalk (MIB Browse → Walk). Hard-capped at SNMP_WALK_HARD_MAX rows. */
export async function snmpWalkRaw(
  host: string,
  config: Record<string, unknown>,
  baseOid: string,
  maxRows: number,
): Promise<SnmpWalkResult> {
  const cap = Math.max(1, Math.min(maxRows | 0, SNMP_WALK_HARD_MAX));
  const start = Date.now();
  const session = buildSnmpSession(host, config);
  session.on?.("error", () => {});
  try {
    return await new Promise<SnmpWalkResult>((resolve, reject) => {
      const rows: SnmpWalkRow[] = [];
      const guard = makeOidMonotonicGuard();
      let truncated = false;
      let done = false;
      const end = (err?: Error) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve({ rows, truncated, durationMs: Date.now() - start });
      };
      try {
        session.subtree(
          baseOid,
          20, // maxRepetitions
          (varbinds: any[]) => {
            for (const vb of varbinds) {
              if ((snmp as any).isVarbindError(vb)) continue;
              if (typeof vb.oid !== "string") continue;
              if (!guard.advance(vb.oid)) {
                end(walkLoopError(baseOid, guard.last()!, vb.oid));
                return true;
              }
              rows.push({ oid: vb.oid, type: snmpTypeName(vb.type), value: snmpVarbindToPrintable(vb) });
              if (rows.length >= cap) {
                truncated = true;
                end();
                return true;
              }
            }
          },
          (err?: Error) => end(err),
        );
      } catch (err: any) {
        end(err);
      }
    });
  } finally {
    try { session.close?.(); } catch { /* ignore */ }
  }
}

// ─── WinRM / SSH / REST API ──────────────────────────────────────────────────

async function probeWinRm(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const useHttps = config.useHttps !== false;
  const port = toPositiveInt(config.port, useHttps ? 5986 : 5985);
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) return finish(start, false, "WinRM credential incomplete");

  // Minimal WS-Management Identify request — exercises authentication
  // without needing a configured shell/runspace.
  const body =
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd">` +
    `<s:Header/><s:Body><wsmid:Identify/></s:Body></s:Envelope>`;

  const url = new URL(`${useHttps ? "https" : "http"}://${urlHost(host)}:${port}/wsman`);
  const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const reqFn = useHttps ? httpsRequest : httpRequest;
    const req = reqFn({
      hostname: bareHost(url.hostname),
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        "Authorization":  auth,
        "Content-Type":   "application/soap+xml;charset=UTF-8",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      // verifyTls: true checks the CA chain; otherwise the certificate is
      // pinned on first use and checked before the Authorization header is
      // written (polaris business rule 113).
      rejectUnauthorized: config.verifyTls === true,
      ...(useHttps && config.verifyTls !== true ? { agent: pinnedAgentFor(bareHost(url.hostname), Number(url.port)) } : {}),
      timeout: timeoutMs,
    } as any, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        if (res.statusCode === 200) return finishOnce(finish(start, true));
        if (res.statusCode === 401) return finishOnce(finish(start, false, "WinRM authentication failed"));
        finishOnce(finish(start, false, `WinRM HTTP ${res.statusCode}`));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch { /* ignore */ } finishOnce(finish(start, false, "WinRM timed out")); });
    req.on("error", (err) => finishOnce(finish(start, false, err.message || "WinRM error")));
    req.write(body);
    req.end();
  });
}

async function probeSsh(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const port = toPositiveInt(config.port, 22);
  const username = String(config.username || "");
  const password = typeof config.password === "string" ? config.password : "";
  const privateKey = typeof config.privateKey === "string" ? config.privateKey : "";
  const passphrase = typeof config.passphrase === "string" ? config.passphrase : "";
  if (!username || (!password && !privateKey)) return finish(start, false, "SSH credential incomplete");

  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const client = new SshClient();
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { client.end(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SSH timed out")), timeoutMs);
    client.on("ready", () => {
      clearTimeout(timer);
      finishOnce(finish(start, true));
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      finishOnce(finish(start, false, err.message || "SSH error"));
    });
    try {
      const opts: any = { host, port, username, readyTimeout: timeoutMs };
      if (privateKey) {
        opts.privateKey = privateKey;
        if (passphrase) opts.passphrase = passphrase;
      } else {
        opts.password = password;
      }
      const verifier = buildHostVerifier(host, port, config);
      if (verifier) opts.hostVerifier = verifier;
      client.connect(opts);
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SSH connect failed"));
    }
  });
}

/**
 * REST API credential test — HTTPS GET to the credential's baseUrl with
 * `Authorization: Bearer <apiToken>`; 200/204 = success, 401/403 named as an
 * auth failure (the URL is reachable, the token is wrong).
 */
async function probeRestApiCredential(config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const baseUrl = String(config.baseUrl || "");
  const apiToken = String(config.apiToken || "");
  const verifyTls = config.verifyTls === true;
  if (!baseUrl) return finish(start, false, "REST API credential is missing baseUrl");
  if (!apiToken) return finish(start, false, "REST API credential is missing apiToken");
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { return finish(start, false, "REST API baseUrl is not a valid URL"); }
  const isHttps = url.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const restPort = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const req = reqFn({
      hostname: bareHost(url.hostname),
      port:     restPort,
      path:     url.pathname + (url.search || ""),
      method:   "GET",
      headers:  { "Authorization": "Bearer " + apiToken, "Accept": "application/json,*/*" },
      rejectUnauthorized: !!verifyTls,
      ...(isHttps && !verifyTls ? { agent: pinnedAgentFor(bareHost(url.hostname), restPort) } : {}),
      timeout:  timeoutMs,
    } as any, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        const code = res.statusCode || 0;
        if (code === 200 || code === 204) return finishOnce(finish(start, true));
        if (code === 401 || code === 403) return finishOnce(finish(start, false, "REST API authentication failed (HTTP " + code + ")"));
        if (code === 0)                   return finishOnce(finish(start, false, "REST API request returned no status"));
        finishOnce(finish(start, false, "REST API HTTP " + code));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch { /* ignore */ } finishOnce(finish(start, false, "REST API timed out")); });
    req.on("error",   (err) => finishOnce(finish(start, false, err.message || "REST API error")));
    req.end();
  });
}

// ─── HTTP check ──────────────────────────────────────────────────────────────

interface RawHttpExchange {
  statusCode: number;
  wwwAuthenticate: string | null;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

/**
 * One GET against the target, up/down by status code and optionally a string
 * the body must carry (utils/httpCheck.ts evaluateHttpCheck). Redirects are
 * never followed; the body is capped at MAX_BODY_BYTES; Digest is answered
 * exactly once. `auth` is the http Credential; `config` the check definition.
 */
export async function probeHttp(
  host: string,
  config: Record<string, unknown>,
  start: number,
  timeoutMs: number,
  out?: { diag?: HttpProbeDiagnostics },
  auth?: Record<string, unknown> | null,
  lookup?: LookupFunction,
): Promise<ProbeResult> {
  const cfg = config as HttpCheckConfig;
  const authCfg = (auth || {}) as HttpAuthConfig;
  const target = resolveHttpTarget(cfg, null);
  const reqFn = target.useHttps ? httpsRequest : httpRequest;
  const authMode = resolveHttpAuthMode(authCfg);
  // A check that sends a password or token over TLS without a CA check sends
  // it only to the pinned certificate. An unauthenticated check is left alone.
  const pinned = target.useHttps && cfg.verifyTls !== true && authMode !== "none";

  const issueOnce = (
    extraAuth: string | null,
    perRequestTimeoutMs: number,
  ): Promise<{ exchange?: RawHttpExchange; error?: string }> => {
    const headers: Record<string, string> = { "Accept": "*/*" };
    if (extraAuth) headers["Authorization"] = extraAuth;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: { exchange?: RawHttpExchange; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const req = reqFn({
        hostname: host,
        port:     target.port,
        path:     target.path,
        method:   "GET",
        headers,
        rejectUnauthorized: cfg.verifyTls === true,
        ...(pinned ? { agent: pinnedAgentFor(host, target.port) } : {}),
        ...(lookup ? { lookup } : {}),
        timeout:  perRequestTimeoutMs,
      } as any, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = () => {
          const wa = res.headers?.["www-authenticate"] as string | string[] | undefined;
          const ctype = res.headers?.["content-type"];
          settle({
            exchange: {
              statusCode:      res.statusCode || 0,
              wwwAuthenticate: Array.isArray(wa) ? wa.join(", ") : typeof wa === "string" ? wa : null,
              contentType:     typeof ctype === "string" ? ctype : null,
              body:            Buffer.concat(chunks).toString("utf8"),
              truncated,
            },
          });
        };
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, MAX_BODY_BYTES - (size - chunk.length))));
            try { res.destroy(); } catch { /* ignore */ }
            try { req.destroy(); } catch { /* ignore */ }
            done();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", done);
        res.on("error", (err: any) => settle({ error: err?.message || "HTTP response error" }));
      });
      req.on("timeout", () => { try { req.destroy(); } catch { /* ignore */ } settle({ error: "HTTP check timed out" }); });
      req.on("error",   (err) => settle({ error: err.message || "HTTP check error" }));
      req.end();
    });
  };

  // Bearer and Basic are computable up front; Digest needs the challenge.
  // "form" (a device admin login) deliberately sends NO header.
  let preAuth: string | null = null;
  if (authMode === "bearer" && typeof authCfg.apiToken === "string" && authCfg.apiToken) {
    preAuth = "Bearer " + authCfg.apiToken;
  } else if (authMode === "basic" &&
             typeof authCfg.username === "string" && authCfg.username &&
             typeof authCfg.password === "string" && authCfg.password) {
    preAuth = "Basic " + Buffer.from(`${authCfg.username}:${authCfg.password}`).toString("base64");
  }

  const first = await issueOnce(preAuth, timeoutMs);
  if (first.error || !first.exchange) return finish(start, false, first.error || "HTTP check failed");

  let exchange = first.exchange;
  let digestNegotiated = false;
  let authNote: string | null = null;

  if (authMode === "digest" && exchange.statusCode === 401) {
    const challenge = parseDigestChallenge(exchange.wwwAuthenticate);
    if (!challenge) {
      const offered = authSchemesOffered(exchange.wwwAuthenticate);
      authNote = offered.length
        ? `Device requested ${offered.join("/")} auth, not Digest`
        : "Device returned 401 with no Digest challenge";
    } else {
      try {
        const authz = buildDigestAuthorization({
          challenge,
          username: String(authCfg.username || ""),
          password: String(authCfg.password || ""),
          method:   "GET",
          uri:      target.path,
          cnonce:   newCnonce(),
          nc:       1,
        });
        const remaining = Math.max(1000, Math.round(timeoutMs - (performance.now() - start)));
        const second = await issueOnce(authz, remaining);
        if (second.error || !second.exchange) return finish(start, false, second.error || "HTTP check failed");
        exchange = second.exchange;
        digestNegotiated = true;
      } catch (err: any) {
        authNote = err?.message || "Digest authentication failed";
      }
    }
  }

  const outcome = evaluateHttpCheck({
    statusCode: exchange.statusCode,
    body:       exchange.body,
    config:     cfg,
    truncated:  exchange.truncated,
  });

  if (out) {
    const ex = bodyExcerpt(exchange.body);
    const offered = authSchemesOffered(exchange.wwwAuthenticate ?? first.exchange.wwwAuthenticate);
    out.diag = {
      url:                describeHttpTarget(host, target),
      statusCode:         exchange.statusCode,
      contentType:        exchange.contentType,
      bytesRead:          Buffer.byteLength(exchange.body),
      bodyTruncatedAtCap: exchange.truncated,
      excerpt:            ex.text,
      excerptTruncated:   ex.truncated,
      matched:            outcome.matched,
      authRequested:      offered.length ? offered : null,
      digestNegotiated,
    };
  }

  if (!outcome.ok) return finish(start, false, authNote ? `${outcome.error} — ${authNote}` : outcome.error);
  return finish(start, true);
}

/**
 * Run a one-shot probe against `host` with the given credential type +
 * config, writing nothing but trust-on-first-use pins. `check` is the HTTP
 * check definition (http only); `lookup` the netGuard lookup for a typed host.
 */
export async function probeCredentialAgainstHost(
  host: string,
  type: "snmp" | "winrm" | "ssh" | "restapi" | "http",
  config: Record<string, unknown>,
  out?: { diag?: HttpProbeDiagnostics },
  check?: Record<string, unknown> | null,
  lookup?: LookupFunction,
): Promise<ProbeResult> {
  const start = performance.now();
  if (!host && type !== "restapi") return finish(start, false, "Host is required");
  const timeoutMs = PROBE_TIMEOUT_MS;
  try {
    if (type === "snmp")    return await probeSnmp(host, config, timeoutMs);
    if (type === "winrm")   return await probeWinRm(host, config, start, timeoutMs);
    if (type === "ssh")     return await probeSsh(host, config, start, timeoutMs);
    if (type === "restapi") return await probeRestApiCredential(config, start, timeoutMs);
    if (type === "http")    return await probeHttp(host, check || {}, start, timeoutMs, out, config, lookup);
    return finish(start, false, `Unsupported credential type "${String(type)}"`);
  } catch (err: any) {
    return finish(start, false, err?.message || "Probe failed");
  }
}
