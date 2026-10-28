/**
 * src/services/webServerService.ts — Server Settings → Web Server: the HTTPS
 * certificate, the managed nginx config, and the zero-downtime certificate
 * rotation that keeps every endpoint agent's leaf-cert pin valid.
 *
 * Ported from polaris nginxApplyService (applyProxyConfig / rotateCertAndKey /
 * preflightCertRotation / getDriftStatus) + certInfo, onto charon's pieces:
 *   - the cert/key paths come from Setting "cert.leaf" (PEM + paths), else the
 *     live nginx config's ssl_certificate lines (install-rhel.sh bootstraps a
 *     self-signed pair at $APP_DIR/state/certs), else STATE_DIR/certs (Docker
 *     bind-mounts state/certs into the nginx container). The key stays on disk
 *     (0600) only — never in the database;
 *   - nginx is applied through charon's single wrapper (charon-nginx-apply.sh:
 *     stage → `nginx -t` → reload, rolling back on failure);
 *   - the agent pin is the leaf SHA-256 in certPinService's canonical+staged
 *     store (bare lowercase hex — polaris used "sha256:<hex>").
 *
 * PIN SAFETY (charon additions — flagged for crypto review):
 *   - rotate refuses a cert whose pin is not already accepted by agents
 *     (staged or canonical), so the swap step can never strand the fleet;
 *     only the very first cert (no canonical pin yet) is exempt;
 *   - after the swap the OLD pin stays staged (accepted) until the operator
 *     retires it, and the pin of the cert being served can never be retired.
 */

import { X509Certificate, createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, copyFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../db.js";
import { STATE_DIR } from "../utils/paths.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getProxyConfig, saveProxyConfig, type ProxyConfig } from "./proxyConfigService.js";
import { renderNginxConfig, sha256Hex } from "./nginxRenderer.js";
import { applyNginxContents, isWrapperAvailable, readLiveNginxConfig, LIVE_NGINX_CONF } from "./nginxApplyService.js";
import { getPinStore, swapCanonicalPin } from "./certPinService.js";

const CERT_SETTING = "cert.leaf";
const DEFAULT_CERT_PATH = resolve(STATE_DIR, "certs", "charon.crt");
const DEFAULT_KEY_PATH = resolve(STATE_DIR, "certs", "charon.key");

// ─── current certificate ─────────────────────────────────────────────────────

interface LeafRecord {
  pem: string | null;
  certPath: string;
  keyPath: string;
}

/** Pure: the ssl_certificate / ssl_certificate_key paths in an nginx config. */
export function parseLiveCertPaths(conf: string | null): { certPath: string | null; keyPath: string | null } {
  if (!conf) return { certPath: null, keyPath: null };
  const strip = conf.replace(/#.*$/gm, "");
  const cert = /^\s*ssl_certificate\s+([^\s;]+)\s*;/m.exec(strip);
  const key = /^\s*ssl_certificate_key\s+([^\s;]+)\s*;/m.exec(strip);
  return { certPath: cert?.[1] ?? null, keyPath: key?.[1] ?? null };
}

async function readLeafRecord(): Promise<LeafRecord> {
  const row = await prisma.setting.findUnique({ where: { key: CERT_SETTING } });
  const v = (row?.value ?? {}) as { pem?: unknown; certPath?: unknown; keyPath?: unknown };
  let certPath = typeof v.certPath === "string" ? v.certPath : null;
  let keyPath = typeof v.keyPath === "string" ? v.keyPath : null;
  if (!certPath || !keyPath) {
    // No recorded paths yet: believe the live nginx config (install-rhel.sh
    // points it at $APP_DIR/state/certs, which is not STATE_DIR on a git
    // install), falling back to STATE_DIR/certs (Docker: /app/state/certs).
    const live = parseLiveCertPaths(await readLiveNginxConfig());
    certPath = certPath ?? live.certPath ?? DEFAULT_CERT_PATH;
    keyPath = keyPath ?? live.keyPath ?? DEFAULT_KEY_PATH;
  }
  let pem = typeof v.pem === "string" ? v.pem : null;
  // Fresh install: nothing uploaded yet — read the bootstrap cert on disk.
  if (!pem) {
    try { pem = readFileSync(certPath, "utf8"); } catch { pem = null; }
  }
  return { pem, certPath, keyPath };
}

export interface CertFacts {
  fingerprint: string;
  cn: string | null;
  dnsSans: string[];
  ipSans: string[];
  expiresAt: string | null;
}

/** Pure: the fields the HTTPS card + rotate preflight show. */
export function certFacts(pem: string): CertFacts {
  const x = new X509Certificate(pem);
  let cn: string | null = null;
  for (const line of (x.subject ?? "").split(/[\r\n]+/)) {
    const m = line.match(/^CN=(.+)$/);
    if (m) { cn = m[1].trim(); break; }
  }
  const dnsSans: string[] = [];
  const ipSans: string[] = [];
  for (const raw of (x.subjectAltName ?? "").split(",")) {
    const s = raw.trim();
    if (s.startsWith("DNS:")) dnsSans.push(s.slice(4).trim());
    else if (s.startsWith("IP Address:")) ipSans.push(s.slice(11).trim());
  }
  const t = Date.parse(x.validTo);
  return {
    fingerprint: createHash("sha256").update(x.raw).digest("hex"),
    cn,
    dnsSans,
    ipSans,
    expiresAt: Number.isNaN(t) ? null : new Date(t).toISOString(),
  };
}

async function currentFacts(): Promise<{ leaf: LeafRecord; facts: CertFacts | null }> {
  const leaf = await readLeafRecord();
  let facts: CertFacts | null = null;
  if (leaf.pem) {
    try { facts = certFacts(leaf.pem); } catch { facts = null; }
  }
  return { leaf, facts };
}

/** SHA-256 (bare hex) of the leaf cert nginx is configured to serve, or null. */
export async function getServedCertFingerprint(): Promise<string | null> {
  return (await currentFacts()).facts?.fingerprint ?? null;
}

function publicUrl(): URL | null {
  try { return process.env.CHARON_PUBLIC_URL ? new URL(process.env.CHARON_PUBLIC_URL) : null; } catch { return null; }
}

export async function getHttpsInfo() {
  const { leaf, facts } = await currentFacts();
  const proxy = await getProxyConfig();
  const u = publicUrl();
  return {
    externallyManaged: true,
    running: true,
    enabled: true,
    port: (u?.port ? Number(u.port) : null) ?? proxy.httpsPort,
    httpPort: null,
    certId: null,
    keyId: null,
    redirectHttp: false,
    fingerprint: facts?.fingerprint ?? null,
    cn: facts?.cn ?? null,
    dnsSans: facts?.dnsSans ?? [],
    ipSans: facts?.ipSans ?? [],
    expiresAt: facts?.expiresAt ?? null,
    certPath: leaf.certPath,
  };
}

// ─── managed nginx config ────────────────────────────────────────────────────

function renderFor(proxy: ProxyConfig, leaf: LeafRecord): string {
  return renderNginxConfig({
    // server_name derives from CHARON_PUBLIC_URL ("_" = catch-all, as install-rhel.sh).
    serverName: publicUrl()?.hostname || "_",
    // Upstream ports are the ones install-rhel.sh / the systemd units use.
    webPort: 3000,
    endpointPort: 3001,
    certPath: leaf.certPath,
    keyPath: leaf.keyPath,
    proxy,
  });
}

export interface DriftStatus {
  managedMode: boolean;
  liveHash: string | null;
  expectedHash: string | null;
  driftMarkers: string[];
}

export async function getDriftStatus(): Promise<DriftStatus> {
  const cfg = await getProxyConfig();
  const live = await readLiveNginxConfig();
  const driftMarkers: string[] = [];
  let liveHash: string | null = null;
  if (live === null) {
    driftMarkers.push(`live nginx config not readable at ${LIVE_NGINX_CONF} (nginx not on this host, e.g. a container)`);
  } else {
    liveHash = sha256Hex(live);
    if (cfg.lastAppliedHash === null) driftMarkers.push("live config was not written by Charon Server Settings");
    else if (liveHash !== cfg.lastAppliedHash) driftMarkers.push("live config differs from the last config Charon applied (hand-edited?)");
  }
  return { managedMode: cfg.managedMode, liveHash, expectedHash: cfg.lastAppliedHash, driftMarkers };
}

const NO_WRAPPER_MESSAGE =
  "nginx cannot be reconfigured from Charon in this deployment — the privileged apply wrapper " +
  "(deploy/scripts/charon-nginx-apply.sh + its sudoers rule) is not installed on this host (Docker or dev). " +
  "Render deploy/nginx/charon.conf.template for your nginx yourself.";

export interface ApplyResult {
  ok: boolean;
  hash: string;
  wrapperOutput: string;
  listening?: string;
}

export async function applyProxyConfig(changes?: Partial<ProxyConfig>): Promise<ApplyResult> {
  if (!isWrapperAvailable()) throw new AppError(503, NO_WRAPPER_MESSAGE);
  const cfg = changes ? await saveProxyConfig(changes) : await getProxyConfig();
  if (!cfg.managedMode) {
    throw new AppError(409, "proxyConfig is in adopt-required mode — click 'Adopt managed mode' before apply");
  }
  const contents = renderFor(cfg, await readLeafRecord());
  const hash = sha256Hex(contents);
  const r = await applyNginxContents(contents);
  if (!r.ok) return { ok: false, hash, wrapperOutput: r.output };
  await saveProxyConfig({ lastAppliedAt: new Date().toISOString(), lastAppliedHash: hash });
  return { ok: true, hash, wrapperOutput: r.output };
}

// ─── certificate rotation ────────────────────────────────────────────────────

/** Pure: cert parses, is unexpired, and the key's public half matches it. */
export function validateCertKeyPair(certPem: string, keyPem: string): X509Certificate {
  let cert: X509Certificate;
  try { cert = new X509Certificate(certPem); } catch { throw new AppError(400, "Cert PEM does not parse as a valid X.509 certificate"); }
  const notAfter = Date.parse(cert.validTo);
  if (Number.isFinite(notAfter) && notAfter < Date.now()) {
    throw new AppError(400, `Certificate has already expired (validTo=${cert.validTo})`);
  }
  let priv;
  try { priv = createPrivateKey(keyPem); } catch { throw new AppError(400, "Key PEM does not parse as a valid private key"); }
  const keySpki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const certSpki = cert.publicKey.export({ format: "der", type: "spki" });
  if (!certSpki.equals(keySpki)) throw new AppError(400, "Private key does not match the certificate's public key");
  return cert;
}

export async function preflightCertRotation(certPem: string, keyPem: string) {
  validateCertKeyPair(certPem, keyPem);
  const f = certFacts(certPem);
  const store = await getPinStore();
  return {
    newFingerprint: f.fingerprint,
    newCn: f.cn,
    newDnsSans: f.dnsSans,
    newExpiresAt: f.expiresAt,
    // The pin agents trust today — what step 4 retires.
    currentFingerprint: store.canonical ?? (await getServedCertFingerprint()),
  };
}

function writeSecretFile(path: string, contents: string, mode: number): void {
  const tmp = `${path}.new`;
  writeFileSync(tmp, contents, { encoding: "utf-8", mode });
  try { chmodSync(tmp, mode); } catch { /* non-POSIX */ }
  renameSync(tmp, path);
}

export interface RotateResult {
  ok: boolean;
  fingerprint?: string;
  wrapperOutput: string;
  /** Charon: set when nginx could not be reloaded from here (Docker/dev). */
  note?: string;
}

export async function rotateCertAndKey(certPem: string, keyPem: string): Promise<RotateResult> {
  validateCertKeyPair(certPem, keyPem);
  const newPin = certFacts(certPem).fingerprint;

  const store = await getPinStore();
  if (store.canonical && store.canonical !== newPin && !store.staged.includes(newPin)) {
    throw new AppError(
      409,
      "The new certificate's pin is not staged on the agents yet — run step 2 (Stage pin) first, or every agent would refuse the new certificate.",
    );
  }

  const leaf = await readLeafRecord();
  const wrapper = isWrapperAvailable();
  let liveContents: string | null = null;
  if (wrapper) {
    liveContents = await readLiveNginxConfig();
    if (liveContents !== null && !liveContents.includes(leaf.certPath)) {
      throw new AppError(
        409,
        `The live nginx config does not serve ${leaf.certPath} — adopt managed mode and Save & Apply first, so the swap lands on the file nginx reads.`,
      );
    }
    if (liveContents === null) {
      const cfg = await getProxyConfig();
      if (!cfg.managedMode) throw new AppError(409, `Cannot read ${LIVE_NGINX_CONF}; adopt managed mode so Charon can render it.`);
      liveContents = renderFor(cfg, leaf);
    }
  }

  // Back up the current pair, write the new one (key 0600), atomically.
  mkdirSync(resolve(leaf.certPath, ".."), { recursive: true });
  const backups: Array<[string, string]> = [];
  for (const p of [leaf.certPath, leaf.keyPath]) {
    if (existsSync(p)) { copyFileSync(p, `${p}.prev`); backups.push([`${p}.prev`, p]); }
  }
  try { if (existsSync(`${leaf.keyPath}.prev`)) chmodSync(`${leaf.keyPath}.prev`, 0o600); } catch { /* non-POSIX */ }
  writeSecretFile(leaf.certPath, certPem, 0o644);
  writeSecretFile(leaf.keyPath, keyPem, 0o600);

  let wrapperOutput: string;
  let note: string | undefined;
  if (wrapper) {
    // Re-stage the live config unchanged: the wrapper's `nginx -t` loads the
    // new pair, and the reload picks it up. On failure, put the old pair back.
    const r = await applyNginxContents(liveContents!);
    wrapperOutput = r.output;
    if (!r.ok) {
      for (const [prev, live] of backups) { try { copyFileSync(prev, live); } catch { /* best effort */ } }
      if (backups.length === 0) { for (const p of [leaf.certPath, leaf.keyPath]) { try { unlinkSync(p); } catch { /* none */ } } }
      logger.warn({ output: r.output }, "cert rotation failed — previous pair restored");
      return { ok: false, wrapperOutput };
    }
  } else {
    wrapperOutput = "";
    note =
      `No nginx apply wrapper on this host (Docker/dev): the new pair was written to ${leaf.certPath}; ` +
      "reload nginx (e.g. restart the nginx container) to start serving it.";
  }

  await prisma.setting.upsert({
    where: { key: CERT_SETTING },
    create: { key: CERT_SETTING, value: { pem: certPem, certPath: leaf.certPath, keyPath: leaf.keyPath } },
    update: { value: { pem: certPem, certPath: leaf.certPath, keyPath: leaf.keyPath } },
  });
  // New pin canonical; the old one stays accepted until step 4 retires it.
  await swapCanonicalPin(newPin);
  return { ok: true, fingerprint: newPin, wrapperOutput, note };
}
