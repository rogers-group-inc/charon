/**
 * src/services/apiTokenService.ts — Long-lived bearer tokens for external callers.
 *
 * Tokens are `charon_<base64url>`; only their SHA-384 hash is stored (the
 * plaintext is shown once at mint time). Lookup is prefix-indexed then
 * constant-time compared against the stored hash.
 *
 * Ported from polaris: each token is bound to a Role at mint time and acts
 * with that role's permission matrix wherever requirePermission gates (see
 * permissions.ts resolveSnapshot). An optional trustedHosts list (IPs/CIDRs,
 * matched against the trust-proxy-resolved req.ip) limits the source
 * addresses the token is accepted from; empty = any source. The source check
 * runs AFTER the hash matches, so only a holder of the real token learns it
 * was refused for its address — and that refusal names the address Charon saw.
 *
 * Charon adaptations: SHA-384 (not argon2id) per charon's crypto policy; no
 * per-token integration list (polaris's FortiGate-quarantine binding has no
 * charon equivalent). Legacy tokens minted before role binding have
 * roleId=null and reach nothing gated by requirePermission.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { generateToken, sha384hex, timingSafeHexEqual } from "../utils/crypto.js";
import { ipMatchesAllowlist, ipVersion, isValidAllowlistEntry, normalizeV4Cidr } from "../utils/ipAllowlist.js";
import {
  FUNCTION_KEYS,
  normalizePermissions,
  isAdminEquivalentPermissions,
  type AccessLevel,
} from "../api/middleware/permissions.js";
import { logEvent } from "./eventService.js";

const TOKEN_PREFIX = "charon";
const PREFIX_DISPLAY_LEN = 12;

/** Upper bound on a token's trusted-host list — a list this long is a network, not a host set. */
export const MAX_TRUSTED_HOSTS = 64;

export interface AuthenticatedToken {
  id: string;
  name: string;
  roleId: string | null;
  scopes: string[];
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  roleId: string | null;
  roleName: string | null;
  integrationIds: string[]; // always [] in charon (polaris quarantine binding)
  trustedHosts: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}

/**
 * Validate and canonicalize an operator-entered trusted-host list: trims,
 * drops blanks, rejects anything that is not an IPv4/IPv6 address or CIDR (a
 * typo must fail the save, never sit in the list matching nothing), zeroes
 * host bits on IPv4 CIDRs and de-duplicates. Empty in → empty out ("any").
 */
export function normalizeTrustedHosts(raw: readonly string[] | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const item of raw) {
    let entry = String(item ?? "").trim().toLowerCase();
    if (!entry) continue;
    if (!isValidAllowlistEntry(entry)) {
      invalid.push(entry);
      continue;
    }
    if (entry.includes("/") && ipVersion(entry.split("/")[0]) === 4) entry = normalizeV4Cidr(entry);
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  if (invalid.length > 0) {
    throw new AppError(
      400,
      `Invalid trusted host${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")} — each must be an IP address or a CIDR such as 10.20.0.0/16`,
    );
  }
  if (out.length > MAX_TRUSTED_HOSTS) {
    throw new AppError(400, `A token may list at most ${MAX_TRUSTED_HOSTS} trusted hosts — use a wider CIDR instead`);
  }
  return out;
}

const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };

/**
 * Privilege-escalation guard (polaris business rule 48): a token acts with its
 * role's whole matrix, so binding one to a role that exceeds the caller on any
 * function key is minting authority the caller was never given. Returns the
 * keys where the role exceeds the caller (empty = allowed).
 */
export function grantExceedsCaller(rolePermissions: unknown, callerPermissions: unknown): string[] {
  const role = normalizePermissions(rolePermissions);
  const caller = normalizePermissions(callerPermissions);
  return FUNCTION_KEYS.map((f) => f.key).filter((k) => ACCESS_RANK[role[k]] > ACCESS_RANK[caller[k]]);
}

export interface CreateTokenInput {
  name: string;
  roleId: string;
  trustedHosts?: string[];
  expiresAt?: Date | null;
  createdBy: string;
  /** The caller's permission matrix — the role must not exceed it. */
  callerPermissions: unknown;
}

export interface CreateTokenResult {
  token: ApiTokenSummary;
  rawToken: string; // Shown ONCE; never recoverable later.
}

const withRole = { role: { select: { name: true } } } as const;

export async function createToken(input: CreateTokenInput): Promise<CreateTokenResult> {
  const name = input.name?.trim();
  if (!name) throw new AppError(400, "Token name is required");
  if (!input.roleId?.trim()) throw new AppError(400, "Token role is required");

  const role = await prisma.role.findUnique({ where: { id: input.roleId } });
  if (!role) throw new AppError(400, `Role ${input.roleId} not found`);
  const exceeds = grantExceedsCaller(role.permissions, input.callerPermissions);
  if (exceeds.length > 0) {
    throw new AppError(
      403,
      `You cannot mint a token bound to the role "${role.name}" — it grants more than your own role on: ${exceeds.join(", ")}`,
    );
  }
  const perms = normalizePermissions(role.permissions);

  const existing = await prisma.apiToken.findUnique({ where: { name } });
  if (existing) throw new AppError(409, `A token named "${name}" already exists`);

  const trustedHosts = normalizeTrustedHosts(input.trustedHosts);
  const { plaintext, hash } = generateToken(TOKEN_PREFIX);

  const row = await prisma.apiToken.create({
    data: {
      name,
      tokenHash: hash,
      tokenPrefix: plaintext.slice(0, PREFIX_DISPLAY_LEN),
      roleId: role.id,
      trustedHosts,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    },
    include: withRole,
  });

  // An admin-equivalent binding is allowed but leaves a loud audit trail — a
  // leaked long-lived token bound to this role is a full-control credential.
  if (isAdminEquivalentPermissions(perms)) {
    void logEvent({
      action: "api_token.admin_equivalent",
      resourceType: "api_token",
      resourceId: row.id,
      resourceName: row.name,
      actor: input.createdBy,
      level: "warning",
      message: `API token "${row.name}" is bound to admin-equivalent role "${role.name}" — anyone holding this token has full control of Charon`,
    });
  }

  return { token: toSummary(row), rawToken: plaintext };
}

/**
 * Role catalogue for the "acts as role" dropdown — embedded in the tokens
 * listing so the tab renders for any caller holding apiTokens=read regardless
 * of their roles-function access. grantsQuarantineWrite is always false in
 * charon (no quarantine push); adminEquivalent drives the warning banner.
 */
export async function listRoleChoices() {
  return (await prisma.role.findMany({ orderBy: { name: "asc" } })).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    grantsQuarantineWrite: false,
    adminEquivalent: isAdminEquivalentPermissions(normalizePermissions(r.permissions)),
  }));
}

export async function listTokens(): Promise<ApiTokenSummary[]> {
  const rows = await prisma.apiToken.findMany({ orderBy: { createdAt: "desc" }, include: withRole });
  return rows.map(toSummary);
}

/**
 * Replace a live token's trusted-host list — the one field editable after
 * mint, because a caller's address changing must not force re-issuing the
 * secret. A revoked token refuses (409).
 */
export async function updateTrustedHosts(
  id: string,
  raw: readonly string[],
): Promise<{ token: ApiTokenSummary; before: string[] }> {
  const trustedHosts = normalizeTrustedHosts(raw);
  const existing = await prisma.apiToken.findUnique({ where: { id }, select: { trustedHosts: true, revokedAt: true } });
  if (!existing) throw new AppError(404, "Token not found");
  if (existing.revokedAt) throw new AppError(409, "Token is revoked — its trusted hosts can no longer be changed");
  const row = await prisma.apiToken.update({ where: { id }, data: { trustedHosts }, include: withRole });
  return { token: toSummary(row), before: existing.trustedHosts };
}

export async function revokeToken(id: string, revokedBy: string): Promise<{ name: string }> {
  const row = await prisma.apiToken.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Token not found");
  if (row.revokedAt) throw new AppError(409, "Token is already revoked");
  await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date(), revokedBy } });
  return { name: row.name };
}

export async function deleteToken(id: string): Promise<{ name: string }> {
  const row = await prisma.apiToken.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!row) throw new AppError(404, "Token not found");
  await prisma.apiToken.delete({ where: { id } });
  return { name: row.name };
}

function toSummary(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  roleId: string | null;
  role: { name: string } | null;
  trustedHosts: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
}): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    roleId: row.roleId,
    roleName: row.role?.name ?? null,
    integrationIds: [],
    trustedHosts: row.trustedHosts,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}

/**
 * Outcome of presenting a bearer token. `untrusted_host` is a REAL token
 * presented from an address outside its trustedHosts list — distinct from
 * "no such token" so the caller can answer 403 with the address it saw.
 */
export type TokenVerification =
  | { ok: true; token: AuthenticatedToken }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "untrusted_host"; tokenName: string; callerIp: string | null };

// One warning Event per (token, source address) per window — a leaked token
// replayed from outside its trusted hosts must leave a trail, but a client
// retrying every second must not write 3600 rows an hour.
const UNTRUSTED_EVENT_WINDOW_MS = 15 * 60 * 1000;
const UNTRUSTED_EVENT_MAX_KEYS = 1000;
const untrustedEventLoggedAt = new Map<string, number>();

function noteUntrustedHost(row: { id: string; name: string; trustedHosts: string[] }, callerIp: string | null): void {
  const key = `${row.id}|${callerIp ?? ""}`;
  const now = Date.now();
  const last = untrustedEventLoggedAt.get(key);
  if (last !== undefined && now - last < UNTRUSTED_EVENT_WINDOW_MS) return;
  if (untrustedEventLoggedAt.size >= UNTRUSTED_EVENT_MAX_KEYS) untrustedEventLoggedAt.clear();
  untrustedEventLoggedAt.set(key, now);
  void logEvent({
    action: "api_token.untrusted_host",
    resourceType: "api_token",
    resourceId: row.id,
    resourceName: row.name,
    actor: `api:${row.name}`,
    level: "warning",
    message: `API token "${row.name}" was presented from ${callerIp || "an unknown address"}, which is not one of its trusted hosts (${row.trustedHosts.join(", ")}) — request refused`,
    details: { callerIp, trustedHosts: row.trustedHosts },
  });
}

/** Test hook: forget which (token, address) pairs have already logged. */
export function _resetUntrustedHostEventThrottle(): void {
  untrustedEventLoggedAt.clear();
}

/**
 * Verify a presented bearer token. Returns the token identity, `invalid`
 * (unknown, revoked or expired), or `untrusted_host` (a real token from an
 * address outside its trustedHosts — lastUsed is NOT bumped and a throttled
 * warning Event is written). Updates last-used metadata best-effort on success.
 */
export async function verifyToken(raw: string, callerIp: string | null): Promise<TokenVerification> {
  if (!raw || !raw.startsWith(TOKEN_PREFIX + "_")) return { ok: false, reason: "invalid" };
  const prefix = raw.slice(0, PREFIX_DISPLAY_LEN);
  const candidates = await prisma.apiToken.findMany({ where: { tokenPrefix: prefix } });
  const hash = sha384hex(raw);
  const now = new Date();
  for (const c of candidates) {
    if (!timingSafeHexEqual(c.tokenHash, hash)) continue;
    if (c.revokedAt) return { ok: false, reason: "invalid" };
    if (c.expiresAt && c.expiresAt < now) return { ok: false, reason: "invalid" };
    if (c.trustedHosts.length > 0 && !ipMatchesAllowlist(callerIp, c.trustedHosts)) {
      noteUntrustedHost(c, callerIp);
      return { ok: false, reason: "untrusted_host", tokenName: c.name, callerIp };
    }
    void prisma.apiToken
      .update({ where: { id: c.id }, data: { lastUsedAt: now, lastUsedIp: callerIp } })
      .catch(() => {});
    return { ok: true, token: { id: c.id, name: c.name, roleId: c.roleId, scopes: c.scopes } };
  }
  return { ok: false, reason: "invalid" };
}

/** Public API base URL for external callers, or null when CHARON_PUBLIC_URL is unset. */
export function getPublicApiBaseUrl(): string | null {
  const raw = process.env.CHARON_PUBLIC_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin + "/api/v1";
  } catch {
    return null;
  }
}
