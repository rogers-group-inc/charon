/**
 * src/services/credentials/credentialService.ts — ported from polaris
 * src/services/credentialService.ts (Server Settings → Credentials).
 *
 * Named credential store (SNMP v2c/v3, WinRM, SSH, REST API, HTTP). Charon
 * adaptation: secret fields are AES-256-GCM envelopes AT REST (see "Charon:
 * encryption at rest" below) and masked at the API boundary via
 * `stripSecrets()`; usage resolution is empty (no Asset inventory). ICMP
 * doesn't use credentials so there's no "icmp" type here.
 *
 * "restapi" credentials carry a baseUrl + bearer token pair so manually-
 * created assets can be probed via the same REST-API path FMG/FortiGate-
 * discovered firewalls use through their integration's stored token.
 *
 * "http" credentials carry AUTHENTICATION ONLY — bearer token, basic, or digest
 * (utils/httpCheck.ts). They used to carry the whole HTTP health check as well
 * (path, expected status, expected body), but that half moved to a manufacturer
 * custom widget in 2026-08 because the two vary on different axes: a login is
 * per-vendor or per-site, while "which path, expecting what" is per-vendor and
 * model. Sharing one row meant a second path needed a second copy of the same
 * password, and rotating the password meant editing every path.
 *
 * There is no "none" mode: an unauthenticated check is a widget with no
 * credential attached, not a credential that authenticates nothing.
 */

import { trimTrailing } from "../../utils/trimTrailing.js";
import { safeRegexProblem } from "../../utils/safeRegex.js";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../utils/errors.js";
import { encryptSecret, decryptSecret, isEncryptedEnvelope } from "../../utils/crypto.js";
import { SECRET_MASK, isMaskedSecret } from "../../utils/secretMask.js";
import {
  type HttpCheckConfig,
  normalizeHttpPath,
  resolveHttpAuthMode,
  HTTP_CREDENTIAL_AUTH_MODES,
  type HttpAuthConfig,
} from "./httpCheck.js";

export type CredentialType = "snmp" | "winrm" | "ssh" | "restapi" | "http";

export interface SnmpV2cConfig {
  version: "v2c";
  community: string;
  port?: number;
}

export type SnmpV3AuthProtocol = "MD5" | "SHA" | "SHA224" | "SHA256" | "SHA384" | "SHA512";
export type SnmpV3PrivProtocol = "DES" | "AES" | "AES256B" | "AES256R";

export const SNMP_V3_AUTH_PROTOCOLS: readonly SnmpV3AuthProtocol[] = [
  "MD5", "SHA", "SHA224", "SHA256", "SHA384", "SHA512",
];
export const SNMP_V3_PRIV_PROTOCOLS: readonly SnmpV3PrivProtocol[] = [
  "DES", "AES", "AES256B", "AES256R",
];

export interface SnmpV3Config {
  version: "v3";
  username: string;
  securityLevel: "noAuthNoPriv" | "authNoPriv" | "authPriv";
  authProtocol?: SnmpV3AuthProtocol;
  authKey?: string;
  privProtocol?: SnmpV3PrivProtocol;
  privKey?: string;
  port?: number;
}

export type SnmpConfig = SnmpV2cConfig | SnmpV3Config;

export interface WinRmConfig {
  username: string;
  password: string;
  port?: number;
  useHttps?: boolean;
}

/**
 * SSH credential. `privateKey` wins over `password` at every connect site
 * (remoteExec.withSshClient, monitoringService.probeSsh).
 *
 * `publicKey` is the `authorized_keys` one-liner for a Polaris-GENERATED
 * keypair (windowsSshOnboardingService). It is deliberately NOT a secret:
 * it must survive `stripSecrets` so the Windows onboarding script can be
 * re-rendered at any time from the stored credential. Regenerating the key
 * to recover a public half nobody kept would mean re-touching every endpoint
 * that trusts the old one.
 */
export interface SshConfig {
  username: string;
  password?: string;
  privateKey?: string;
  publicKey?: string;
  /**
   * Unlocks an ENCRYPTED `privateKey`. Only meaningful for an operator-supplied
   * key from their own escrow — a Polaris-generated deployment key is never
   * exported, so a passphrase on it would just sit next to the key it protects.
   * Without this, ssh2 fails at parse with "Encrypted private OpenSSH key
   * detected, but no passphrase given".
   */
  passphrase?: string;
  port?: number;
  /**
   * Authenticate the SERVER via trust-on-first-use host-key pinning
   * (sshHostKeyService). Opt-in, mirroring WinRM's `verifyTls`: absent /
   * false keeps the pre-2026-08 behavior where ssh2 accepts ANY host key,
   * so enabling it can't break an install whose hosts were never pinned.
   * New credentials default it ON in the form.
   */
  verifyHostKey?: boolean;
}

/**
 * REST API credential — a base URL + bearer token. Used by the REST API
 * polling method when the asset's source doesn't already have a token
 * (i.e. manually-created assets, or any asset where the operator wants
 * to override with a different token). FMG/FortiGate-discovered firewalls
 * keep using the integration's stored token by default.
 *
 * verifyTls defaults to false (parity with FortiOS REST behaviour where
 * self-signed device certs are common); operators flip it on when their
 * target presents a real cert.
 */
export interface RestApiConfig {
  baseUrl: string;
  apiToken: string;
  verifyTls?: boolean;
}

/**
 * HTTP-check credential. The shape lives in utils/httpCheck.ts (shared with the
 * probe and its unit tests) rather than being redeclared here — this is the
 * same type, re-exported under the credential vocabulary so callers reading
 * this file can find it.
 */
export type { HttpCheckConfig } from "./httpCheck.js";

export type CredentialConfig = SnmpConfig | WinRmConfig | SshConfig | RestApiConfig | HttpCheckConfig;

export interface CredentialRecord {
  id: string;
  name: string;
  type: CredentialType;
  config: Record<string, unknown>;
  // Ownership dimension for the `credentials` function key — the username
  // that created the row, or null for a row that predates the column
  // (unowned; fullwrite-only). Never inferred: the routes stamp it on
  // create and no update path may rewrite it, or a write-level operator
  // could adopt someone else's credential by saving it.
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveCredentialInput {
  name: string;
  type: CredentialType;
  config: Record<string, unknown>;
  createdBy?: string | null;
}

export interface UpdateCredentialInput {
  name?: string;
  config?: Record<string, unknown>;
}

const MASK = SECRET_MASK;

/**
 * Field names treated as secrets. Returned masked on every GET and
 * preserved from the stored value on PUT when the caller resubmits the
 * mask (or an empty string).
 */
const SECRET_FIELDS_BY_TYPE: Record<CredentialType, string[]> = {
  snmp:    ["community", "authKey", "privKey"],
  winrm:   ["password"],
  ssh:     ["password", "privateKey", "passphrase"],
  restapi: ["apiToken"],
  // An http check's auth is optional (plenty of health endpoints are
  // unauthenticated) but when present it is a real credential, so both carriers
  // mask and seal. `expectBody` deliberately does NOT — it is the thing the
  // operator needs to see and edit on every visit to the form, and masking it
  // would make the check un-reviewable.
  http:    ["apiToken", "password"],
};

function secretFieldsFor(type: string): string[] {
  return SECRET_FIELDS_BY_TYPE[type as CredentialType] ?? [];
}

export function stripSecrets(cred: CredentialRecord): CredentialRecord {
  const config = { ...(cred.config || {}) } as Record<string, unknown>;
  for (const field of secretFieldsFor(cred.type)) {
    const v = config[field];
    if (typeof v === "string" && v.length > 0) {
      config[field] = MASK;
    }
  }
  return { ...cred, config };
}

function isMaskedValue(v: unknown): boolean {
  return isMaskedSecret(v) || (typeof v === "string" && v.trim() === "");
}

function normalizeName(name: string): string {
  return name.trim();
}

function validateSnmpConfig(config: Record<string, unknown>): void {
  const version = config.version;
  if (version !== "v2c" && version !== "v3") {
    throw new AppError(400, "SNMP config requires version 'v2c' or 'v3'");
  }
  if (version === "v2c") {
    if (typeof config.community !== "string" || !config.community) {
      throw new AppError(400, "SNMP v2c requires a community string");
    }
  } else {
    if (typeof config.username !== "string" || !config.username) {
      throw new AppError(400, "SNMP v3 requires a username");
    }
    const level = config.securityLevel;
    if (level !== "noAuthNoPriv" && level !== "authNoPriv" && level !== "authPriv") {
      throw new AppError(400, "SNMP v3 requires securityLevel noAuthNoPriv, authNoPriv, or authPriv");
    }
    if (level === "authNoPriv" || level === "authPriv") {
      if (!SNMP_V3_AUTH_PROTOCOLS.includes(config.authProtocol as SnmpV3AuthProtocol)) {
        throw new AppError(
          400,
          `SNMP v3 authProtocol must be one of ${SNMP_V3_AUTH_PROTOCOLS.join(", ")} when auth is enabled`,
        );
      }
      if (typeof config.authKey !== "string" || !config.authKey) {
        throw new AppError(400, "SNMP v3 authKey is required when auth is enabled");
      }
    }
    if (level === "authPriv") {
      if (!SNMP_V3_PRIV_PROTOCOLS.includes(config.privProtocol as SnmpV3PrivProtocol)) {
        throw new AppError(
          400,
          `SNMP v3 privProtocol must be one of ${SNMP_V3_PRIV_PROTOCOLS.join(", ")} when authPriv is selected`,
        );
      }
      if (typeof config.privKey !== "string" || !config.privKey) {
        throw new AppError(400, "SNMP v3 privKey is required when authPriv is selected");
      }
    }
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "SNMP port must be between 1 and 65535");
    }
  }
}

function validateWinRmConfig(config: Record<string, unknown>): void {
  if (typeof config.username !== "string" || !config.username) {
    throw new AppError(400, "WinRM requires a username");
  }
  if (typeof config.password !== "string" || !config.password) {
    throw new AppError(400, "WinRM requires a password");
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "WinRM port must be between 1 and 65535");
    }
  }
}

function validateSshConfig(config: Record<string, unknown>): void {
  if (typeof config.username !== "string" || !config.username) {
    throw new AppError(400, "SSH requires a username");
  }
  const hasPassword = typeof config.password === "string" && config.password.length > 0;
  const hasKey      = typeof config.privateKey === "string" && config.privateKey.length > 0;
  if (!hasPassword && !hasKey) {
    throw new AppError(400, "SSH requires either a password or a private key");
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "SSH port must be between 1 and 65535");
    }
  }
  if (config.verifyHostKey !== undefined && typeof config.verifyHostKey !== "boolean") {
    throw new AppError(400, "SSH verifyHostKey must be a boolean");
  }
  // A passphrase unlocks a private key and means nothing without one. Catching
  // it here beats a connect-time parse error the operator has to decode.
  if (typeof config.passphrase === "string" && config.passphrase.length > 0 && !hasKey) {
    throw new AppError(400, "SSH passphrase only applies to a private key — add the key, or clear the passphrase");
  }
}

function validateRestApiConfig(config: Record<string, unknown>): void {
  if (typeof config.baseUrl !== "string" || !config.baseUrl) {
    throw new AppError(400, "REST API credential requires a baseUrl");
  }
  // Defensive URL parse — operators may paste a hostname with no scheme,
  // a trailing path, or even a stray newline. We require an http(s) scheme
  // because the polling code can't talk anything else, and we trim trailing
  // slashes so the probe path concatenation doesn't double up. The trim
  // happens at validation time so the stored value is canonical.
  let u: URL;
  try { u = new URL(config.baseUrl.trim()); }
  catch { throw new AppError(400, "REST API baseUrl must be a valid URL (e.g. https://device.example/)"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AppError(400, "REST API baseUrl must use http:// or https://");
  }
  config.baseUrl = trimTrailing(u.toString(), "/");
  if (typeof config.apiToken !== "string" || !config.apiToken) {
    throw new AppError(400, "REST API credential requires an apiToken");
  }
  if (config.verifyTls !== undefined && typeof config.verifyTls !== "boolean") {
    throw new AppError(400, "REST API verifyTls must be a boolean");
  }
}

/**
 * Validate an `http` CREDENTIAL — which since 2026-08 carries authentication
 * and nothing else. The check definition it used to hold (path, expected
 * status, expected body, TLS verification) moved to a manufacturer custom
 * widget; `validateHttpCheckDefinition` below validates that half wherever it
 * now appears.
 *
 * "none" is not an accepted mode here. A credential exists to authenticate, so
 * one that authenticates nothing is an empty row that still reads as
 * configuration — and an unauthenticated check is already expressible by a
 * widget selecting no credential at all, which is the same outcome without the
 * misleading artefact.
 */
function validateHttpConfig(config: Record<string, unknown>): void {
  if (config.authMode === undefined || config.authMode === null || config.authMode === "") {
    throw new AppError(400, `HTTP credential requires an authentication type: ${HTTP_CREDENTIAL_AUTH_MODES.join(", ")}`);
  }
  if (typeof config.authMode !== "string" ||
      !(HTTP_CREDENTIAL_AUTH_MODES as readonly string[]).includes(config.authMode)) {
    throw new AppError(400, `HTTP credential auth type must be one of: ${HTTP_CREDENTIAL_AUTH_MODES.join(", ")}`);
  }
  const authMode = config.authMode as string;
  const hasUser = typeof config.username === "string" && config.username.length > 0;
  const hasPass = typeof config.password === "string" && config.password.length > 0;

  if (authMode === "bearer" && !(typeof config.apiToken === "string" && config.apiToken.length > 0)) {
    throw new AppError(400, "HTTP credential bearer auth needs an API token");
  }
  // "form" is the device admin login the firmware repository posts to a
  // switch or AP's own login page (business rule 87) — the same two carriers
  // as basic / digest, and the same requirement that both be present.
  if ((authMode === "basic" || authMode === "digest" || authMode === "form") && !(hasUser && hasPass)) {
    // Named per mode: "basic auth needs..." on a digest credential sends the
    // operator looking for a field that isn't the one they got wrong.
    throw new AppError(400, `HTTP credential ${authMode} ${authMode === "form" ? "login" : "auth"} needs both a username and a password`);
  }

  // Drop the carriers this mode does not send, and every field left over from
  // the pre-split shape. This runs on the MERGED config (validateConfig is
  // called after mergeConfigPreservingSecrets on both the create and update
  // paths), which is the only place a stored secret can actually be removed:
  // blanking a secret in the request body means "keep the stored value" to the
  // merge, so a client-side clear would preserve the very credential it appears
  // to delete.
  if (authMode !== "bearer") delete config.apiToken;
  if (authMode !== "basic" && authMode !== "digest" && authMode !== "form") {
    delete config.username;
    delete config.password;
  }
  for (const stale of CHECK_DEFINITION_FIELDS) delete config[stale];
}

/**
 * Fields that used to live on an `http` credential and now belong to the check
 * definition. Stripped on the next save of any credential still carrying them —
 * the values are not migrated, because the credential had no manufacturer or
 * model to attribute a widget to and guessing one would invent configuration
 * nobody wrote.
 */
const CHECK_DEFINITION_FIELDS = [
  "useHttps", "port", "path", "expectStatus", "expectBody",
  "matchMode", "caseSensitive", "failOnMismatch", "verifyTls",
] as const;

/**
 * Validate a CHECK DEFINITION — the half that answers "which request, and what
 * answer counts as healthy". Shared by the manufacturer custom widget (where it
 * is stored) and the credential Test Connection flow (where it is supplied ad
 * hoc), so a check cannot be accepted in one place and rejected in the other.
 *
 * Mutates its argument to canonicalize, matching validateConfig's convention:
 *
 *  - the regex is COMPILED here, because an invalid pattern would otherwise
 *    fail once per asset per interval forever, with the operator finding out
 *    from a probe error column instead of the form they typed it into.
 *  - `path` is canonicalized (leading slash) so the stored value is what the
 *    request line will actually carry.
 *  - `caseSensitive` is only meaningful alongside an `expectBody`; a lone
 *    toggle is accepted rather than rejected (harmless, and rejecting it would
 *    400 a form the operator is mid-way through).
 *  - `failOnMismatch` is STRIPPED. A mismatch now always fails (see
 *    utils/httpCheck.ts), so a stored `false` would silently mean something the
 *    UI can no longer express and the evaluator no longer honours.
 */
export function validateHttpCheckDefinition(config: Record<string, unknown>): void {
  if (config.useHttps !== undefined && typeof config.useHttps !== "boolean") {
    throw new AppError(400, "HTTP check useHttps must be a boolean");
  }
  if (config.port !== undefined && config.port !== null) {
    const p = Number(config.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new AppError(400, "HTTP check port must be between 1 and 65535");
    }
    config.port = p;
  }
  if (config.path !== undefined && config.path !== null && typeof config.path !== "string") {
    throw new AppError(400, "HTTP check path must be a string");
  }
  // Canonicalize so the stored value equals the request line. A blank path is
  // stored as "/" here (unlike Asset.httpCheckPath, where blank means "no
  // override") — this IS the definition, so it has to name a path.
  config.path = normalizeHttpPath(typeof config.path === "string" ? config.path : null);

  if (config.expectStatus !== undefined && config.expectStatus !== null) {
    const s = Number(config.expectStatus);
    if (!Number.isInteger(s) || s < 100 || s > 599) {
      throw new AppError(400, "HTTP check expected status must be a status code between 100 and 599");
    }
    config.expectStatus = s;
  }
  const mode = config.matchMode;
  if (mode !== undefined && mode !== null && mode !== "contains" && mode !== "regex") {
    throw new AppError(400, 'HTTP check matchMode must be "contains" or "regex"');
  }
  if (config.expectBody !== undefined && config.expectBody !== null && typeof config.expectBody !== "string") {
    throw new AppError(400, "HTTP check expected content must be a string");
  }
  const expectBody = typeof config.expectBody === "string" ? config.expectBody : "";
  if (mode === "regex" && expectBody) {
    // Must compile on RE2, the engine both the server and the agent run it on
    // (business rule 116).
    const problem = safeRegexProblem(expectBody, { ignoreCase: config.caseSensitive !== true });
    if (problem) throw new AppError(400, `HTTP check regex is invalid: ${problem}`);
  }
  for (const flag of ["caseSensitive", "verifyTls"]) {
    if (config[flag] !== undefined && typeof config[flag] !== "boolean") {
      throw new AppError(400, `HTTP check ${flag} must be a boolean`);
    }
  }
  // Retired knob — see the doc comment. Dropped rather than rejected so an
  // existing widget re-saves cleanly instead of 400-ing on a field the form
  // never sent.
  delete config.failOnMismatch;
}

export function validateConfig(type: CredentialType, config: Record<string, unknown>): void {
  if (type === "snmp")    validateSnmpConfig(config);
  else if (type === "winrm")   validateWinRmConfig(config);
  else if (type === "ssh")     validateSshConfig(config);
  else if (type === "restapi") validateRestApiConfig(config);
  else if (type === "http")    validateHttpConfig(config);
  else throw new AppError(400, `Unknown credential type "${type}"`);
  validateAllowReboot(type, config);
}

/**
 * The credential kinds that can reboot a FortiGate, FortiSwitch or FortiAP
 * (business rule 115): an SSH login (`execute reboot`), a REST API token
 * (FortiOS `system/os/reboot`), and a device admin login (`http` in `form`
 * mode — the firmware repository's login, rule 87). Pure; shared by the
 * validator, the reboot resolver and the form.
 */
export function credentialCanReboot(type: string, config: Record<string, unknown> | null | undefined): boolean {
  if (type === "ssh" || type === "restapi") return true;
  return type === "http" && (config ?? {}).authMode === "form";
}

/** `allowReboot` is on, on a kind that can carry it. Pure. */
export function credentialAllowsReboot(type: string, config: Record<string, unknown> | null | undefined): boolean {
  return credentialCanReboot(type, config) && (config ?? {}).allowReboot === true;
}

/**
 * `allowReboot` (rule 115) is a boolean, and only on a kind that can reboot.
 * Runs on the MERGED config after the per-type validator, so an http
 * credential switched away from form login loses the flag with the login it
 * belonged to instead of 400-ing; `true` sent on a kind that can never reboot
 * (SNMP, WinRM) is refused so the operator does not believe it did something.
 * A `false` is not stored — absence is the default.
 */
function validateAllowReboot(type: CredentialType, config: Record<string, unknown>): void {
  const v = config.allowReboot;
  if (v === undefined || v === null) { delete config.allowReboot; return; }
  if (typeof v !== "boolean") throw new AppError(400, "allowReboot must be a boolean");
  if (!v) { delete config.allowReboot; return; }
  if (credentialCanReboot(type, config)) return;
  if (type === "http") { delete config.allowReboot; return; }
  throw new AppError(400, `A ${type} credential cannot reboot a device — Allow reboots applies to SSH, REST API and device admin login credentials`);
}

/**
 * Merge incoming config onto the stored one, preserving any secret field
 * whose incoming value is either the mask sentinel or empty. Lets the
 * edit modal round-trip a masked value without wiping the real secret.
 */
export function mergeConfigPreservingSecrets(
  type: CredentialType,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  for (const field of secretFieldsFor(type)) {
    if (isMaskedValue(incoming[field])) {
      merged[field] = existing[field];
    }
  }
  return merged;
}

// ─── Charon: encryption at rest + scoping to the Credentials-tab types ─────
//
// Polaris stores credential secrets plaintext (masked at the API). Charon's
// rule is AES-256-GCM envelopes at rest (utils/crypto.ts), so every secret
// field is sealed on write and opened only when a caller asks to reveal
// (the test probe / MIB walk). Masking (stripSecrets) works unchanged: an
// envelope is a non-empty string and is replaced by the mask like plaintext.
//
// The `credentials` table predates this tab in Charon (its comment named
// "ldap" | "restapi" for integrations). Rows of any other type are not this
// tab's: they are hidden from the list and every by-id call 404s on them, so
// nothing here can edit, test or delete a credential another surface owns.

export const CREDENTIAL_TYPES: readonly CredentialType[] = ["snmp", "winrm", "ssh", "restapi", "http"];

function isTabType(type: string): type is CredentialType {
  return (CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Seal every secret field of a (plaintext, validated) config. Pure apart from the key. */
export function sealSecrets(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const field of secretFieldsFor(type)) {
    const v = out[field];
    if (typeof v === "string" && v.length > 0 && !isEncryptedEnvelope(v)) out[field] = encryptSecret(v);
  }
  return out;
}

/** Open every sealed secret field. A row written before sealing (plaintext) passes through. */
export function openSecrets(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const field of secretFieldsFor(type)) {
    const v = out[field];
    if (isEncryptedEnvelope(v)) {
      try {
        out[field] = decryptSecret(v);
      } catch {
        throw new AppError(500, "A stored credential secret could not be decrypted — has CHARON_DATA_KEY changed?");
      }
    }
  }
  return out;
}

function toRecord(row: unknown): CredentialRecord {
  return row as CredentialRecord;
}

async function findByName(name: string, excludeId?: string): Promise<CredentialRecord | null> {
  // Names are unique across the whole table, integration rows included.
  const found = await prisma.credential.findUnique({ where: { name } });
  if (!found) return null;
  if (excludeId && found.id === excludeId) return null;
  return toRecord(found);
}

async function findTabRow(id: string) {
  const row = await prisma.credential.findUnique({ where: { id } });
  if (!row || !isTabType(row.type)) throw new AppError(404, "Credential not found");
  return row;
}

export async function listCredentials(): Promise<CredentialRecord[]> {
  const rows = await prisma.credential.findMany({
    where: { type: { in: [...CREDENTIAL_TYPES] } },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => stripSecrets(toRecord(r)));
}

export async function getCredential(id: string, opts?: { revealSecrets?: boolean }): Promise<CredentialRecord> {
  const cred = toRecord(await findTabRow(id));
  if (!opts?.revealSecrets) return stripSecrets(cred);
  return { ...cred, config: openSecrets(cred.type, (cred.config as Record<string, unknown>) || {}) };
}

export async function createCredential(input: SaveCredentialInput): Promise<CredentialRecord> {
  const name = normalizeName(input.name);
  if (!name) throw new AppError(400, "Credential name is required");
  if (input.type !== "snmp" && input.type !== "winrm" && input.type !== "ssh" && input.type !== "restapi" && input.type !== "http") {
    throw new AppError(400, "Credential type must be snmp, winrm, ssh, restapi, or http");
  }
  if (!input.config || typeof input.config !== "object") {
    throw new AppError(400, "Credential config is required");
  }
  validateConfig(input.type, input.config);
  if (await findByName(name)) {
    throw new AppError(409, `A credential named "${name}" already exists`);
  }
  const created = await prisma.credential.create({
    data: {
      name,
      type: input.type,
      config: sealSecrets(input.type, input.config) as Prisma.InputJsonValue,
      // Stamped once, at create. `updateCredential` takes no createdBy and
      // never writes one, so ownership cannot be reassigned by an edit.
      createdBy: input.createdBy ?? null,
    },
  });
  return stripSecrets(toRecord(created));
}

export async function updateCredential(id: string, input: UpdateCredentialInput): Promise<CredentialRecord> {
  const existing = await findTabRow(id);

  const data: Prisma.CredentialUpdateInput = {};
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (!name) throw new AppError(400, "Credential name cannot be empty");
    if (await findByName(name, id)) {
      throw new AppError(409, `A credential named "${name}" already exists`);
    }
    data.name = name;
  }
  if (input.config) {
    const merged = mergeConfigPreservingSecrets(
      existing.type as CredentialType,
      openSecrets(existing.type, (existing.config as Record<string, unknown>) || {}),
      input.config,
    );
    validateConfig(existing.type as CredentialType, merged);
    data.config = sealSecrets(existing.type, merged) as Prisma.InputJsonValue;
  }
  const updated = await prisma.credential.update({ where: { id }, data });
  return stripSecrets(toRecord(updated));
}

// ─── Credential usage ("where is this credential wired?") ───────────────────
//
// Polaris resolves usage through the monitor-settings tiers (asset / class /
// integration) plus the Firmware Repository binding and agent installs, all of
// which hang off its Asset inventory. Charon has no assets, so every usage
// answer is the empty one — the same shapes, so the table's Assets column
// reads 0 and the usage slide-in renders its empty state.

export interface CredentialUsageAsset {
  assetId: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  monitored: boolean;
  status: string;
  streams: string[];
}

export interface CredentialUsageClassGroup {
  integrationId: string | null;
  integrationName: string | null;
  assetType: string;
  streams: string[];
  assets: CredentialUsageAsset[];
}

export interface CredentialUsageIntegrationGroup {
  integrationId: string;
  integrationName: string;
  assets: CredentialUsageAsset[];
}

export interface CredentialUsageOperationGroup {
  kind: "firmware" | "agent";
  label: string;
  assets: CredentialUsageAsset[];
}

export interface CredentialUsage {
  credentialId: string;
  total: number;
  monitoringTotal: number;
  assetLevel: CredentialUsageAsset[];
  classLevel: CredentialUsageClassGroup[];
  integrationLevel: CredentialUsageIntegrationGroup[];
  operationLevel: CredentialUsageOperationGroup[];
  classRefCount: number;
  integrationRefCount: number;
}

/** Effective-usage asset count per credential — always empty in Charon (no assets). */
export async function getCredentialUsageCounts(): Promise<Record<string, number>> {
  return {};
}

/** Full usage breakdown for one credential (404 when it is not this tab's). */
export async function getCredentialUsage(id: string): Promise<CredentialUsage> {
  await findTabRow(id);
  return {
    credentialId: id, total: 0, monitoringTotal: 0,
    assetLevel: [], classLevel: [], integrationLevel: [], operationLevel: [],
    classRefCount: 0, integrationRefCount: 0,
  };
}

export async function deleteCredential(id: string): Promise<void> {
  await findTabRow(id); // 404 if missing or not this tab's
  // Nothing in Charon blocks the delete: a manufacturer custom widget that
  // authenticates with it is SET NULL (the check survives and fails loudly,
  // as in polaris), and a firmware login binding names it loosely.
  try {
    await prisma.credential.delete({ where: { id } });
  } catch (err: any) {
    if (err?.code === "P2025") throw new AppError(404, "Credential not found");
    throw err;
  }
}
