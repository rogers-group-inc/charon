/**
 * src/services/haEnrollmentService.ts — how a node joins the HA pair.
 *
 * Ported from polaris. The operator never copies secrets around by hand. The
 * tab mints a single-use token, hands them a thin bootstrap script carrying
 * it, and the node fetches everything else itself over a pinned TLS connection.
 *
 * ── Why redeeming the token is not enough ─────────────────────────────────────
 * The standby's bundle contains the whole install: .env (with CHARON_DATA_KEY,
 * which decrypts every stored credential), the nginx private key (agents pin
 * that leaf, so the standby must serve the same one), and the replication
 * password. So the token buys one thing only — the right to ASK. Registration
 * records who asked, from which address, presenting which SSH host keys, and
 * waits. An operator approves in the UI; only then can the bundle be
 * downloaded, once, from the address that registered.
 *
 * ── Shape of the flow ─────────────────────────────────────────────────────────
 *   tab:  POST /ha/tokens                   → issued
 *   node: POST /ha/enroll                   → pending   (token spent here)
 *   tab:  POST /ha/enrollments/:id/approve  → approved
 *   node: GET  /ha/enroll/:req?download=1   → delivered (terminal)
 *
 * Charon adaptations: tokens are `charon_<base64url>` hashed with SHA-384 (not
 * argon2id) and the poll handle is stored as its SHA-384; the bundle is a flat
 * `KEY=<base64>` text file (no tar) that the script decodes into files and
 * hands to deploy/setup-ha.sh; there are two roles (no witness/etcd/Patroni).
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import { generateToken, sha384hex, timingSafeHexEqual } from "../utils/crypto.js";
import { ENV_FILE, STATE_DIR } from "../utils/paths.js";
import { getAgentCertPins } from "./certPinService.js";
import { leafPin } from "./certInfo.js";
import {
  getHaConfig,
  revealReplicationPassword,
  rememberNodeHostKeys,
  type HaConfig,
  type HaNode,
  type HaRole,
} from "./haService.js";

const TOKEN_PREFIX = "charon";
const TOKEN_PREFIX_LEN = 12;

/** 24 hours — a human workflow: download the script, then walk to the machine. */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a registered node may wait for approval before it gives up. */
export const APPROVAL_WINDOW_MS = 30 * 60 * 1000;
/** How long an approved bundle stays claimable (the script polls every 5 s). */
export const CLAIM_WINDOW_MS = 10 * 60 * 1000;

/** charon install root on RHEL (deploy/install-rhel.sh APP_DIR). */
const APP_DIR = "/opt/charon";
/**
 * Bash lines that resolve the host's PGDG major at run time, as deploy/setup-ha.sh
 * does: a fresh install-rhel.sh host runs 17, but an older host keeps the major it
 * was installed with, so a generated script must never bake one in.
 */
const PG_DETECT_LINES = [
  "PG_MAJOR=\"$(ls -d /usr/pgsql-[0-9]* 2>/dev/null | sed 's#.*/pgsql-##' | sort -n | tail -1)\"",
  "[[ -n \"$PG_MAJOR\" ]] || { echo 'no PGDG PostgreSQL under /usr/pgsql-*' >&2; exit 1; }",
  "PGDATA=\"/var/lib/pgsql/${PG_MAJOR}/data\"",
  "PG_SERVICE=\"postgresql-${PG_MAJOR}\"",
];

/** The stored form of a poll handle: only its SHA-384 is ever written. */
export function hashRequestId(requestId: string): string {
  return sha384hex(requestId);
}

/**
 * Expire every row whose window has passed — an issued token past expiresAt, a
 * pending registration past APPROVAL_WINDOW_MS, an approval past
 * CLAIM_WINDOW_MS. Run before every lookup rather than on a timer.
 */
export async function expireStaleEnrollments(now = new Date()): Promise<number> {
  const res = await prisma.haEnrollment.updateMany({
    where: {
      OR: [
        { status: "issued", expiresAt: { lt: now } },
        { status: "pending", registeredAt: { lt: new Date(now.getTime() - APPROVAL_WINDOW_MS) } },
        { status: "approved", approvedAt: { lt: new Date(now.getTime() - CLAIM_WINDOW_MS) } },
      ],
    },
    data: { status: "expired" },
  });
  return res.count;
}

export type EnrollmentStatus = "issued" | "pending" | "approved" | "delivered" | "rejected" | "expired";

// ─── Minting ────────────────────────────────────────────────────────────────

export interface MintedToken {
  id: string;
  role: HaRole;
  nodeName: string;
  nodeAddr: string;
  /** Shown once, embedded in the script, never stored in plaintext. */
  token: string;
  expiresAt: Date;
}

/** Mint a token for one node, expiring any earlier unused one for the same role. */
export async function mintNodeToken(role: HaRole, actor: string): Promise<MintedToken> {
  const cfg = await getHaConfig();
  if (!cfg.enabled) throw new AppError(409, "Enable high availability first.");
  const node = cfg.nodes[role];
  if (!node) throw new AppError(400, `No ${role} node is configured.`);

  await prisma.haEnrollment.updateMany({
    where: { role, status: { in: ["issued", "pending", "approved"] } },
    data: { status: "expired" },
  });

  const { plaintext, hash } = generateToken(TOKEN_PREFIX);
  const row = await prisma.haEnrollment.create({
    data: {
      role,
      nodeName: node.name,
      nodeAddr: node.clusterAddr,
      tokenHash: hash,
      tokenPrefix: plaintext.slice(0, TOKEN_PREFIX_LEN),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      status: "issued",
      createdBy: actor,
    },
  });
  logger.info({ actor, role, nodeName: node.name }, "HA node token minted");
  return { id: row.id, role, nodeName: node.name, nodeAddr: node.clusterAddr, token: plaintext, expiresAt: row.expiresAt };
}

// ─── Registration ───────────────────────────────────────────────────────────

export interface RegisterInput {
  token: string;
  nodeName: string;
  sshHostKeyFingerprints: string[];
  sourceIp: string | null;
}

/**
 * Spend the token and record a pending request. Every failure returns the same
 * 401 text — an unauthenticated caller learns nothing about whether a token
 * existed, expired or was already used.
 */
export async function registerEnrollment(input: RegisterInput): Promise<{ requestId: string; role: string }> {
  await expireStaleEnrollments();
  const raw = (input.token || "").trim();
  if (!raw.startsWith(TOKEN_PREFIX + "_")) throw new AppError(401, "Enrollment token rejected");
  const hash = sha384hex(raw);
  const candidates = await prisma.haEnrollment.findMany({
    where: { tokenPrefix: raw.slice(0, TOKEN_PREFIX_LEN), status: "issued", expiresAt: { gt: new Date() } },
  });
  for (const row of candidates) {
    if (!timingSafeHexEqual(row.tokenHash, hash)) continue;
    const requestId = randomBytes(32).toString("hex");
    // Conditional on status: two simultaneous registrations cannot both win.
    const claimed = await prisma.haEnrollment.updateMany({
      where: { id: row.id, status: "issued" },
      data: {
        status: "pending",
        requestIdHash: hashRequestId(requestId),
        registeredFromIp: input.sourceIp,
        registeredNodeName: input.nodeName || null,
        sshHostKeyFingerprints: (input.sshHostKeyFingerprints ?? []).slice(0, 8),
        registeredAt: new Date(),
      },
    });
    if (claimed.count !== 1) throw new AppError(401, "Enrollment token rejected");
    logger.warn(
      { role: row.role, nodeName: input.nodeName, sourceIp: input.sourceIp, enrollmentId: row.id },
      "HA node registered and is awaiting operator approval",
    );
    return { requestId, role: row.role };
  }
  throw new AppError(401, "Enrollment token rejected");
}

export interface EnrollmentPollResult {
  status: EnrollmentStatus;
  ready: boolean;
  message: string;
}

/** What the bootstrap script's poll loop sees. */
export async function pollEnrollment(requestId: string): Promise<EnrollmentPollResult> {
  await expireStaleEnrollments();
  const row = await prisma.haEnrollment.findUnique({ where: { requestIdHash: hashRequestId(requestId) } });
  if (!row) throw new AppError(404, "Unknown enrollment request");
  const status = row.status as EnrollmentStatus;
  switch (status) {
    case "expired":
      return { status, ready: false, message: "This request expired before it was approved and collected. Re-generate the script." };
    case "pending":
      return { status, ready: false, message: "Waiting for an operator to approve this node in Server Settings -> High Availability." };
    case "approved":
      return { status, ready: true, message: "Approved. Downloading the node bundle." };
    case "delivered":
      return { status, ready: false, message: "This bundle has already been downloaded. Re-generate the script to install again." };
    case "rejected":
      return { status, ready: false, message: "An operator rejected this node." };
    default:
      return { status, ready: false, message: "This request is no longer valid. Re-generate the script." };
  }
}

// ─── Approval ───────────────────────────────────────────────────────────────

export async function listEnrollments() {
  await expireStaleEnrollments();
  return prisma.haEnrollment.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, role: true, nodeName: true, nodeAddr: true, status: true,
      registeredFromIp: true, registeredNodeName: true, sshHostKeyFingerprints: true,
      registeredAt: true, approvedBy: true, approvedAt: true, deliveredAt: true,
      expiresAt: true, createdBy: true, createdAt: true,
    },
  });
}

export async function approveEnrollment(id: string, actor: string): Promise<{ role: string; registeredFromIp: string | null }> {
  await expireStaleEnrollments();
  const row = await prisma.haEnrollment.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Enrollment not found");
  if (row.status !== "pending") {
    throw new AppError(409, `This request is ${row.status}, not pending — only a node that has connected and is waiting can be approved.`);
  }
  const updated = await prisma.haEnrollment.updateMany({
    where: { id, status: "pending" },
    data: { status: "approved", approvedBy: actor, approvedAt: new Date() },
  });
  if (updated.count !== 1) throw new AppError(409, "This request changed state — refresh and try again.");
  logger.warn({ actor, enrollmentId: id, role: row.role, sourceIp: row.registeredFromIp }, "HA node approved");
  return { role: row.role, registeredFromIp: row.registeredFromIp };
}

export async function rejectEnrollment(id: string, actor: string): Promise<{ role: string; registeredFromIp: string | null }> {
  const row = await prisma.haEnrollment.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Enrollment not found");
  if (row.status === "delivered") {
    throw new AppError(409, "That bundle has already been delivered — rejecting it now would change nothing. Rotate the credentials instead.");
  }
  await prisma.haEnrollment.update({
    where: { id },
    data: { status: "rejected", rejectedBy: actor, rejectedAt: new Date() },
  });
  logger.warn({ actor, enrollmentId: id, sourceIp: row.registeredFromIp }, "HA node rejected");
  return { role: row.role, registeredFromIp: row.registeredFromIp };
}

// ─── The bundle ─────────────────────────────────────────────────────────────

/** Keys a bundle may carry — the script decodes only these. */
export const BUNDLE_KEYS = ["ROLE", "PRIMARY_ADDR", "STANDBY_ADDR", "REPL_PASS", "ENV_FILE", "TLS_CERT", "TLS_KEY"] as const;
export type BundleKey = (typeof BUNDLE_KEYS)[number];

/** `KEY=<base64>` lines. Base64 keeps every value inert for the bash reader. */
export function serializeBundle(entries: Partial<Record<BundleKey, string>>): string {
  return BUNDLE_KEYS.filter((k) => entries[k] !== undefined)
    .map((k) => `${k}=${Buffer.from(entries[k] as string, "utf8").toString("base64")}`)
    .join("\n") + "\n";
}

function readFirst(paths: string[]): string | null {
  for (const p of paths) {
    try {
      return readFileSync(p, "utf8");
    } catch { /* try next */ }
  }
  return null;
}

/** The nginx leaf + key: STATE_DIR/certs (Certificates tab) or STATE_DIR/state/certs (install-rhel.sh). */
function readTlsPair(): { cert: string | null; key: string | null } {
  const dirs = [resolve(STATE_DIR, "certs"), resolve(STATE_DIR, "state", "certs")];
  return {
    cert: readFirst(dirs.map((d) => resolve(d, "charon.crt"))),
    key: readFirst(dirs.map((d) => resolve(d, "charon.key"))),
  };
}

function requireNode(cfg: HaConfig, role: HaRole): HaNode {
  const n = cfg.nodes[role];
  if (!n) throw new AppError(409, `No ${role} node is configured.`);
  return n;
}

/** Build a node's bundle. The primary gets the replication credential only. */
export function buildNodeBundle(cfg: HaConfig, role: HaRole): string {
  const primary = requireNode(cfg, "primary");
  const standby = requireNode(cfg, "standby");
  const replPass = revealReplicationPassword(cfg);
  if (role === "primary") {
    return serializeBundle({ ROLE: "primary", STANDBY_ADDR: standby.clusterAddr, REPL_PASS: replPass });
  }
  let env: string;
  try {
    env = readFileSync(ENV_FILE, "utf8");
  } catch {
    throw new AppError(500, "Could not read this server's .env — the standby needs the same CHARON_DATA_KEY and database credentials.");
  }
  const tls = readTlsPair();
  return serializeBundle({
    ROLE: "standby",
    PRIMARY_ADDR: primary.clusterAddr,
    REPL_PASS: replPass,
    ENV_FILE: env,
    ...(tls.cert && tls.key ? { TLS_CERT: tls.cert, TLS_KEY: tls.key } : {}),
  });
}

/**
 * Claim the one download this approval allows. The bundle is built FIRST (a
 * build failure does not burn the approval), then the status flips
 * conditionally so two concurrent downloads cannot both succeed. A claim from
 * an address other than the one that registered is refused without spending
 * the approval.
 */
export async function claimBundle(requestId: string, sourceIp: string | null): Promise<{ bundle: string; filename: string; role: string }> {
  await expireStaleEnrollments();
  const row = await prisma.haEnrollment.findUnique({ where: { requestIdHash: hashRequestId(requestId) } });
  if (!row) throw new AppError(404, "Unknown enrollment request");
  if (row.status !== "approved") throw new AppError(403, "This node has not been approved yet.");
  if (row.registeredFromIp && sourceIp !== row.registeredFromIp) {
    logger.warn({ enrollmentId: row.id, registeredFromIp: row.registeredFromIp, sourceIp }, "HA bundle claim refused: source address differs from the registration");
    throw new AppError(403, "This bundle can only be downloaded from the address that registered.");
  }
  const cfg = await getHaConfig();
  if (!cfg.enabled) throw new AppError(409, "High availability is disabled.");
  const bundle = buildNodeBundle(cfg, row.role as HaRole);

  const claimed = await prisma.haEnrollment.updateMany({
    where: { id: row.id, status: "approved", approvedAt: { gte: new Date(Date.now() - CLAIM_WINDOW_MS) } },
    data: { status: "delivered", deliveredAt: new Date() },
  });
  if (claimed.count !== 1) throw new AppError(410, "This bundle has already been downloaded.");
  if (row.sshHostKeyFingerprints.length) await rememberNodeHostKeys(row.role as HaRole, row.sshHostKeyFingerprints);
  logger.warn({ role: row.role, enrollmentId: row.id }, "HA node bundle delivered");
  return { bundle, filename: `charon-ha-${row.role}-bundle.txt`, role: row.role };
}

// ─── The bootstrap script ───────────────────────────────────────────────────

export interface NodeScript {
  filename: string;
  script: string;
}

/** Values interpolated into a script must be inert inside single quotes. */
const SHELL_SAFE = /^[A-Za-z0-9._:\/-]+$/;
function shellSafe(label: string, v: string): string {
  if (!SHELL_SAFE.test(v)) throw new AppError(400, `${label} contains characters that cannot be placed in a script.`);
  return v;
}

export interface NodeScriptInput {
  role: HaRole;
  token: string;
  publicUrl: string;
  /** Lowercase hex SHA-256 of the server leaf cert (the agent pin). */
  certPin: string;
  cfg: HaConfig;
}

/** Resolve what the script needs from this server (public URL + leaf pin). */
export async function renderNodeScriptForServer(role: HaRole, token: string): Promise<NodeScript> {
  const publicUrl = process.env.CHARON_PUBLIC_URL;
  if (!publicUrl) throw new AppError(409, "CHARON_PUBLIC_URL is not set — the node has no address to call back to.");
  let pin = (await getAgentCertPins())[0] ?? null;
  if (!pin) {
    const { cert } = readTlsPair();
    if (cert) {
      try { pin = leafPin(cert); } catch { /* fall through */ }
    }
  }
  if (!pin) throw new AppError(409, "No server certificate pin is known — upload the certificate (Certificates tab) first; the node script pins it.");
  return renderNodeScript({ role, token, publicUrl, certPin: pin, cfg: await getHaConfig() });
}

/**
 * The thin script an operator downloads and runs on the node. It carries no
 * secrets beyond the one-use token: the public URL, the leaf pin, the token.
 *
 * TLS: the script fetches the server's leaf with openssl s_client, refuses
 * unless its SHA-256 equals the pin agents use, then pins that leaf's public
 * key for every curl (`--pinnedpubkey` is enforced even with `-k`, which only
 * skips CA-chain validation). `--resolve` sends the packets to the address
 * configured for this node while SNI/Host keep the public hostname.
 */
export function renderNodeScript(input: NodeScriptInput): NodeScript {
  const { role, token, cfg } = input;
  const self = requireNode(cfg, role);
  const primary = requireNode(cfg, "primary");
  const url = new URL(input.publicUrl);
  const host = shellSafe("Public URL host", url.hostname.replace(/^\[|\]$/g, ""));
  const port = shellSafe("Public URL port", url.port || "443");
  const reach = shellSafe("Address", self.reachPrimaryVia || primary.clusterAddr);
  const name = shellSafe("Node name", self.name);
  const tok = shellSafe("Token", token);
  const pin = shellSafe("Certificate pin", input.certPin.toLowerCase());
  if (!/^[0-9a-f]{64}$/.test(pin)) throw new AppError(409, "The stored certificate pin is not a SHA-256 hex digest.");

  const installStep =
    role === "primary"
      ? [
          "# ── Install: configure THIS host as the replication primary ──",
          "STANDBY_ADDR=$(get_value STANDBY_ADDR)",
          "addr_ok \"$STANDBY_ADDR\" || die 'Bundle carried an invalid standby address.'",
          "bash \"$SETUP_HA\" --role primary --standby-ip \"$STANDBY_ADDR\" --repl-pass-file \"$BUNDLE_DIR/repl_pass\"",
        ]
      : [
          "# ── Install: clone the primary and adopt its configuration ──",
          "PRIMARY_ADDR=$(get_value PRIMARY_ADDR)",
          "addr_ok \"$PRIMARY_ADDR\" || die 'Bundle carried an invalid primary address.'",
          "warn 'This REPLACES the local PostgreSQL data directory with a copy of the primary.'",
          "read -r -p 'Type STANDBY to continue: ' c",
          "[[ \"$c\" == STANDBY ]] || die 'aborted'",
          "systemctl stop charon.target 2>/dev/null || true",
          "bash \"$SETUP_HA\" --role standby --primary-ip \"$PRIMARY_ADDR\" --repl-pass-file \"$BUNDLE_DIR/repl_pass\"",
          "",
          "# Same .env as the primary: CHARON_DATA_KEY must match to decrypt stored",
          "# secrets, and the cloned database carries the primary's role passwords.",
          "if [[ -s \"$BUNDLE_DIR/charon.env\" ]]; then",
          "  [[ -f \"$APP_DIR/.env\" ]] && cp -a \"$APP_DIR/.env\" \"$APP_DIR/.env.pre-ha.$(date +%s)\"",
          "  install -m 0600 -o charon -g charon \"$BUNDLE_DIR/charon.env\" \"$APP_DIR/.env\"",
          "  info \"Installed the primary's .env (previous copy kept as .env.pre-ha.*)\"",
          "fi",
          "",
          "# Same TLS leaf as the primary: agents pin its SHA-256, so after a failover",
          "# this node must present the identical certificate.",
          "if [[ -s \"$BUNDLE_DIR/charon.crt\" && -s \"$BUNDLE_DIR/charon.key\" ]]; then",
          "  CERT_DIR=\"$APP_DIR/state/certs\"",
          "  mkdir -p \"$CERT_DIR\"",
          "  for f in charon.crt charon.key; do [[ -f \"$CERT_DIR/$f\" ]] && cp -a \"$CERT_DIR/$f\" \"$CERT_DIR/$f.pre-ha\"; done",
          "  install -m 0644 -o charon -g charon \"$BUNDLE_DIR/charon.crt\" \"$CERT_DIR/charon.crt\"",
          "  install -m 0600 -o charon -g charon \"$BUNDLE_DIR/charon.key\" \"$CERT_DIR/charon.key\"",
          "  if nginx -t >/dev/null 2>&1; then systemctl reload nginx; else warn 'nginx -t failed — check /etc/nginx/conf.d/charon.conf'; fi",
          "else",
          "  warn 'The bundle carried no TLS certificate — copy the primary’s leaf + key by hand or agents will reject this node after a failover.'",
          "fi",
          "",
          "systemctl start charon.target || warn 'charon.target did not start — check journalctl -u charon-web'",
          "info 'This node is a follower: its web process keeps retrying the leader lock and takes over once the primary is gone and this database is promoted (deploy/HA.md).'",
        ];

  const script = [
    "#!/usr/bin/env bash",
    `# Charon HA bootstrap — ${role} node (${name})`,
    "#",
    "# Run as root on the node named above. It carries no secrets other than a",
    "# single-use token: it registers with Charon, waits for an operator to",
    "# APPROVE this node in Server Settings -> High Availability, then downloads",
    "# its bundle once and runs deploy/setup-ha.sh with it.",
    "#",
    "# The token expires 24 hours after it was generated and works once.",
    "",
    "set -euo pipefail",
    "",
    `CHARON_HOST='${host}'`,
    `CHARON_PORT='${port}'`,
    `CHARON_ADDR='${reach}'`,
    `NODE_ROLE='${role}'`,
    `NODE_NAME='${name}'`,
    `TOKEN='${tok}'`,
    `CERT_PIN='${pin}'`,
    `APP_DIR='${APP_DIR}'`,
    "SETUP_HA=\"$APP_DIR/deploy/setup-ha.sh\"",
    "BUNDLE_DIR=\"/root/charon-ha-bundle-${NODE_ROLE}\"",
    "",
    "RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; NC='\\033[0m'",
    "info()  { echo -e \"${GREEN}[INFO]${NC}  $*\"; }",
    "warn()  { echo -e \"${YELLOW}[WARN]${NC}  $*\"; }",
    "die()   { echo -e \"${RED}[ERROR]${NC} $*\" >&2; exit 1; }",
    "addr_ok() { [[ \"$1\" =~ ^[A-Za-z0-9._:-]+$ ]]; }",
    "",
    "[[ $EUID -eq 0 ]] || die 'must run as root'",
    "for b in curl openssl base64; do command -v \"$b\" >/dev/null || die \"$b is required\"; done",
    "[[ -f \"$SETUP_HA\" ]] || die \"$SETUP_HA not found — install Charon on this host first (deploy/install-rhel.sh).\"",
    "",
    "# ── Pin the server: its leaf SHA-256 must equal the pin agents use ──",
    "if [[ \"$CHARON_ADDR\" == *:* ]]; then CONNECT_ADDR=\"[$CHARON_ADDR]\"; else CONNECT_ADDR=\"$CHARON_ADDR\"; fi",
    "WORK=$(mktemp -d); trap 'rm -rf \"$WORK\"' EXIT",
    "openssl s_client -connect \"${CONNECT_ADDR}:${CHARON_PORT}\" -servername \"$CHARON_HOST\" </dev/null 2>/dev/null \\",
    "  | openssl x509 -outform PEM > \"$WORK/leaf.pem\" || die \"Could not fetch the TLS certificate from ${CONNECT_ADDR}:${CHARON_PORT}\"",
    "FP=$(openssl x509 -in \"$WORK/leaf.pem\" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')",
    "[[ \"$FP\" == \"$CERT_PIN\" ]] || die \"Certificate pin mismatch (got $FP) — this is not the Charon server you generated the script on.\"",
    "SPKI=$(openssl x509 -in \"$WORK/leaf.pem\" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64 -A)",
    "CURL=(curl -sS --fail-with-body --max-time 30 -k --pinnedpubkey \"sha256//${SPKI}\"",
    "      --resolve \"${CHARON_HOST}:${CHARON_PORT}:${CONNECT_ADDR}\")",
    "BASE=\"https://${CHARON_HOST}:${CHARON_PORT}/api/v1/ha\"",
    "",
    "# Present this host's SSH host keys so the operator approves against evidence.",
    "FPRS=''",
    "for f in /etc/ssh/ssh_host_*_key.pub; do",
    "  [[ -f \"$f\" ]] || continue",
    "  fp=$(ssh-keygen -lf \"$f\" 2>/dev/null | awk '{print $2}') || continue",
    "  [[ \"$fp\" =~ ^[A-Za-z0-9+/=:]+$ ]] && FPRS=\"${FPRS:+$FPRS,}\\\"$fp\\\"\"",
    "done",
    "",
    "info \"Registering ${NODE_NAME} (${NODE_ROLE}) with ${CHARON_HOST} via ${CHARON_ADDR}\"",
    "REG=$(\"${CURL[@]}\" -X POST \"${BASE}/enroll\" \\",
    "        -H 'Content-Type: application/json' \\",
    "        -d \"{\\\"token\\\":\\\"${TOKEN}\\\",\\\"nodeName\\\":\\\"${NODE_NAME}\\\",\\\"sshHostKeyFingerprints\\\":[${FPRS}]}\") \\",
    "  || die 'Registration was refused. The token may be expired or already used — generate a new script.'",
    "REQ=$(printf '%s' \"$REG\" | sed -n 's/.*\"requestId\"[[:space:]]*:[[:space:]]*\"\\([0-9a-f]*\\)\".*/\\1/p')",
    "[[ -n \"$REQ\" ]] || die \"Could not read the request id from the response: $REG\"",
    "",
    "warn 'Waiting for an operator to APPROVE this node in Server Settings -> High Availability (up to 30 minutes).'",
    "for i in $(seq 1 360); do",
    "  BODY=$(\"${CURL[@]}\" \"${BASE}/enroll/${REQ}\" || true)",
    "  case \"$BODY\" in",
    "    *'\"ready\":true'*)   info 'Approved.'; break ;;",
    "    *'\"rejected\"'*)     die 'An operator rejected this node.' ;;",
    "    *'\"expired\"'*)      die 'The request expired. Generate a new script.' ;;",
    "    *'\"delivered\"'*)    die 'This bundle was already downloaded. Generate a new script.' ;;",
    "  esac",
    "  [[ $i -eq 360 ]] && die 'Timed out waiting for approval.'",
    "  sleep 5",
    "done",
    "",
    "info 'Downloading the node bundle'",
    "rm -rf \"$BUNDLE_DIR\"; mkdir -p \"$BUNDLE_DIR\"; chmod 0700 \"$BUNDLE_DIR\"",
    "umask 077",
    "\"${CURL[@]}\" \"${BASE}/enroll/${REQ}?download=1\" -o \"$BUNDLE_DIR/bundle.txt\" || die 'Bundle download failed.'",
    "",
    "# KEY=<base64> lines; only known keys are decoded, nothing is evaluated.",
    "get_value() { sed -n \"s/^$1=//p\" \"$BUNDLE_DIR/bundle.txt\" | head -n1 | base64 -d; }",
    "[[ \"$(get_value ROLE)\" == \"$NODE_ROLE\" ]] || die 'Bundle is for a different role.'",
    "get_value REPL_PASS > \"$BUNDLE_DIR/repl_pass\"",
    "grep -q '^ENV_FILE=' \"$BUNDLE_DIR/bundle.txt\" && get_value ENV_FILE > \"$BUNDLE_DIR/charon.env\"",
    "grep -q '^TLS_CERT=' \"$BUNDLE_DIR/bundle.txt\" && get_value TLS_CERT > \"$BUNDLE_DIR/charon.crt\"",
    "grep -q '^TLS_KEY='  \"$BUNDLE_DIR/bundle.txt\" && get_value TLS_KEY  > \"$BUNDLE_DIR/charon.key\"",
    "rm -f \"$BUNDLE_DIR/bundle.txt\"",
    "",
    ...installStep,
    "",
    "shred -u \"$BUNDLE_DIR\"/* 2>/dev/null || rm -f \"$BUNDLE_DIR\"/*",
    "rmdir \"$BUNDLE_DIR\" 2>/dev/null || true",
    "info 'Done. The bundle (private keys, credentials) has been deleted from this host.'",
    "",
  ].join("\n");

  return { filename: `charon-ha-${role}.sh`, script };
}

/** The script that undoes the host changes. Generated, never run by Charon. */
export function renderTeardownScript(): NodeScript {
  const script = [
    "#!/usr/bin/env bash",
    "# Charon HA teardown — return this host to a single-node install.",
    "#",
    "# Run as root on the node that should KEEP the database. If it is currently",
    "# a standby it is promoted to a standalone primary. The database files are",
    "# kept; only the replication plumbing set up by deploy/setup-ha.sh is removed.",
    "# Read deploy/HA.md before running this. Charon never runs it for you.",
    "",
    "set -euo pipefail",
    "[[ $EUID -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }",
    "",
    ...PG_DETECT_LINES,
    "PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -qAt)",
    "",
    "read -r -p 'Type TEARDOWN to remove HA from this host: ' c",
    "[[ \"$c\" == TEARDOWN ]] || { echo 'aborted'; exit 1; }",
    "",
    "if [[ \"$(\"${PSQL[@]}\" -c 'SELECT pg_is_in_recovery()')\" == t ]]; then",
    "  echo 'This node is a standby — promoting it to a standalone primary.'",
    "  sudo -u postgres \"/usr/pgsql-${PG_MAJOR}/bin/pg_ctl\" promote -D \"$PGDATA\" -w",
    "fi",
    "",
    "# Replication settings written by pg_basebackup -R / setup-ha.sh.",
    "\"${PSQL[@]}\" -c 'ALTER SYSTEM RESET primary_conninfo'",
    "\"${PSQL[@]}\" -c 'ALTER SYSTEM RESET primary_slot_name'",
    "rm -f \"$PGDATA/standby.signal\"",
    "",
    "# The physical slot would retain WAL forever with no standby consuming it.",
    "\"${PSQL[@]}\" -c \"SELECT pg_drop_replication_slot('charon_standby') FROM pg_replication_slots WHERE slot_name = 'charon_standby'\" >/dev/null",
    "\"${PSQL[@]}\" -c 'DROP ROLE IF EXISTS charon_repl'",
    "",
    "HBA=\"$PGDATA/pg_hba.conf\"",
    "cp -a \"$HBA\" \"$HBA.pre-teardown.$(date +%s)\"",
    "sed -i '/# charon_standby_repl$/d' \"$HBA\"",
    "rm -f /root/.charon_repl_pass",
    "",
    "systemctl restart \"$PG_SERVICE\"",
    "systemctl restart charon.target 2>/dev/null || true",
    "",
    "echo",
    "echo 'HA removed from this host. It is now a standalone primary.'",
    "echo \"On the OTHER node: stop charon.target and $PG_SERVICE so two primaries never\"",
    "echo 'serve at once, and repoint the GSLB at this node only.'",
    "echo 'Also turn HA off in Server Settings -> High Availability.'",
    "",
  ].join("\n");
  return { filename: "charon-ha-teardown.sh", script };
}
