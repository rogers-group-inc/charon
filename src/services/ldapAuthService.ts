/**
 * src/services/ldapAuthService.ts — operator sign-in against LDAP / Active
 * Directory (bind as the user), group lookup, and provisioning. Ported from
 * polaris.
 *
 * Distinct from activeDirectoryService, which binds a service account to
 * DISCOVER directory objects for tags — this path binds AS the operator to
 * verify their password. Both share src/services/ldapClient.ts.
 *
 * Settings live in the `ldap` Setting row (Users → Authentication → LDAP).
 * `bindPassword` (the search service account's) is a crypto.ts envelope at rest
 * (rule 3), masked on read, and never follows a changed server URL or
 * certificate check (utils/settingSecret.ts).
 *
 * SECURITY:
 *   - Empty passwords are refused BEFORE any bind: an empty-password bind is an
 *     "unauthenticated bind" many servers report as success.
 *   - The username is RFC 4515-escaped before going into searchFilter.
 *   - A name the directory does not know still pays a second (dummy) bind, so
 *     response time does not reveal valid directory usernames.
 */

import { randomUUID } from "node:crypto";
import { type Entry } from "ldapts";
import { AppError } from "../utils/errors.js";
import { createSettingStore } from "./settingsStore.js";
import {
  withBoundLdapClient,
  escapeLdapFilterValue,
  decodeObjectGuid,
  formatLdapError,
  type LdapConnectionConfig,
} from "./ldapClient.js";
import { provisionExternalUser } from "./ssoProvisioning.js";
import { maskSettingSecret, nextSettingSecret, openSettingSecret } from "../utils/settingSecret.js";

export interface LdapSettings {
  enabled: boolean;
  url: string; // ldap://host:389 or ldaps://host:636
  bindDn: string;
  bindPassword: string; // SEALED at rest
  searchBase: string;
  searchFilter: string; // {{username}} placeholder
  tlsVerify: boolean;
  displayNameAttr: string;
  emailAttr: string;
  userIdAttribute: string; // stable per-user id: objectGUID (AD) or entryUUID
  groupAttribute: string; // multi-valued group DNs on the user entry, e.g. memberOf
  groupBaseDn: string; // optional reverse member search base ("" = skip)
  groupFilter: string; // optional reverse member search filter, {{userDn}} placeholder
}

export function defaultLdapSettings(): LdapSettings {
  return {
    enabled: false,
    url: "",
    bindDn: "",
    bindPassword: "",
    searchBase: "",
    searchFilter: "(sAMAccountName={{username}})",
    tlsVerify: true,
    displayNameAttr: "displayName",
    emailAttr: "mail",
    userIdAttribute: "objectGUID",
    groupAttribute: "memberOf",
    groupBaseDn: "",
    groupFilter: "(member={{userDn}})",
  };
}

function parseLdapSettings(raw: unknown): LdapSettings {
  const d = defaultLdapSettings();
  if (raw == null || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const out = { ...d };
  for (const k of Object.keys(d) as (keyof LdapSettings)[]) {
    if (typeof r[k] === typeof d[k]) (out as Record<string, unknown>)[k] = r[k];
  }
  return out;
}

const store = createSettingStore<LdapSettings>({ key: "ldap", ttlMs: 30_000, parse: parseLdapSettings });

export async function getLdapSettings(): Promise<LdapSettings> {
  return store.get();
}

/** Settings as returned to the admin UI — bindPassword masked. */
export async function getLdapSettingsMasked(): Promise<LdapSettings> {
  const s = await getLdapSettings();
  return { ...s, bindPassword: maskSettingSecret(s.bindPassword) };
}

export async function updateLdapSettings(input: Partial<LdapSettings>): Promise<LdapSettings> {
  const cur = await getLdapSettings();
  const d = defaultLdapSettings();
  const pick = (k: keyof LdapSettings) => (typeof input[k] === "string" ? (input[k] as string).trim() : (cur[k] as string));
  const next: LdapSettings = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : cur.enabled,
    url: pick("url"),
    bindDn: pick("bindDn"),
    bindPassword: nextSettingSecret(
      cur.bindPassword,
      input.bindPassword,
      [
        { label: "LDAP server URL", current: cur.url, incoming: input.url },
        { label: "certificate check", current: String(cur.tlsVerify), incoming: input.tlsVerify === undefined ? undefined : String(input.tlsVerify) },
      ],
      "bind password",
    ),
    searchBase: pick("searchBase"),
    searchFilter: pick("searchFilter") || d.searchFilter,
    tlsVerify: typeof input.tlsVerify === "boolean" ? input.tlsVerify : cur.tlsVerify,
    displayNameAttr: pick("displayNameAttr"),
    emailAttr: pick("emailAttr"),
    userIdAttribute: pick("userIdAttribute") || d.userIdAttribute,
    groupAttribute: pick("groupAttribute"),
    groupBaseDn: pick("groupBaseDn"),
    groupFilter: pick("groupFilter"),
  };
  if (next.url && !/^ldaps?:\/\//i.test(next.url)) throw new AppError(400, "LDAP URL must start with ldap:// or ldaps://");
  if (next.searchFilter && !next.searchFilter.includes("{{username}}")) {
    throw new AppError(400, "The search filter must contain {{username}}");
  }
  return store.save(next);
}

export async function isLdapEnabled(): Promise<boolean> {
  const s = await getLdapSettings();
  return !!(s.enabled && s.url && s.bindDn && s.searchBase);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function connConfig(s: LdapSettings, bindDn: string, bindPassword: string): LdapConnectionConfig {
  const u = new URL(s.url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : undefined,
    useLdaps: u.protocol === "ldaps:",
    verifyTls: s.tlsVerify,
    bindDn,
    bindPassword,
  };
}

function firstString(val: unknown): string {
  if (val == null) return "";
  if (Array.isArray(val)) return firstString(val[0]);
  if (Buffer.isBuffer(val)) return val.toString("utf8");
  return String(val).trim();
}

function toStringArray(val: unknown): string[] {
  if (val == null) return [];
  const arr = Array.isArray(val) ? val : [val];
  return arr.map((v) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v)).trim()).filter(Boolean);
}

function extractUid(entry: Entry, attr: string): string {
  const raw = (entry as Record<string, unknown>)[attr];
  if (raw == null) return "";
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (Buffer.isBuffer(first)) return first.length === 16 ? decodeObjectGuid(first) : first.toString("hex").toLowerCase();
  return String(first).trim();
}

/** A bind certain to fail, costing what a real user bind costs. Never throws. */
async function dummyUserBind(s: LdapSettings): Promise<void> {
  const dn = `cn=charon-no-such-user-${randomUUID()},${s.searchBase}`;
  await withBoundLdapClient(connConfig(s, dn, randomUUID()), undefined, async () => { /* never reached */ })
    .catch(() => { /* the failure is the point */ });
}

export interface LdapAuthResult {
  dn: string;
  username: string;
  displayName: string;
  email: string;
  ldapUid: string;
  groups: string[];
}

/**
 * Bind-as-user authentication. Returns the verified profile or throws; the
 * caller maps any throw to the generic "Invalid username or password" so the
 * directory's answer is never leaked.
 */
export async function authenticateLdapUser(username: string, password: string): Promise<LdapAuthResult> {
  if (!password) throw new AppError(401, "Password is required");
  const s = await getLdapSettings();
  if (!s.enabled || !s.url || !s.bindDn || !s.searchBase) throw new AppError(400, "LDAP is not configured");
  const servicePassword = openSettingSecret(s.bindPassword);

  const idAttr = s.userIdAttribute || "objectGUID";
  const bufferAttrs = ["objectguid", "objectsid"].includes(idAttr.toLowerCase()) ? [idAttr] : [];
  const filter = s.searchFilter.replace(/\{\{username\}\}/g, escapeLdapFilterValue(username));

  // Phase 1: service-account bind + locate exactly one user entry.
  const entry = await withBoundLdapClient(connConfig(s, s.bindDn, servicePassword), undefined, async (c) => {
    const { searchEntries } = await c.search(s.searchBase, {
      scope: "sub",
      filter,
      attributes: [s.displayNameAttr, s.emailAttr, idAttr, s.groupAttribute].filter(Boolean),
      explicitBufferAttributes: bufferAttrs,
      sizeLimit: 2,
      timeLimit: 15,
    });
    return searchEntries.length === 1 ? searchEntries[0] : null; // 0 = unknown, >1 = ambiguous
  });
  if (!entry) {
    await dummyUserBind(s);
    throw new AppError(401, "Invalid username or password");
  }
  const userDn = String(entry.dn || "");
  if (!userDn) throw new AppError(502, "LDAP entry has no DN");

  // Phase 2: bind AS the user (fresh client) — the bind alone proves the password.
  await withBoundLdapClient(connConfig(s, userDn, password), undefined, async () => { /* bind is the check */ });

  const groups = new Set(s.groupAttribute ? toStringArray((entry as Record<string, unknown>)[s.groupAttribute]) : []);

  // Optional reverse member search (groups not listed in memberOf). Best effort.
  if (s.groupBaseDn && s.groupFilter) {
    const gFilter = s.groupFilter.replace(/\{\{userDn\}\}/g, escapeLdapFilterValue(userDn));
    try {
      const found = await withBoundLdapClient(connConfig(s, s.bindDn, servicePassword), undefined, async (c) => {
        const { searchEntries } = await c.search(s.groupBaseDn, { scope: "sub", filter: gFilter, attributes: ["dn"], sizeLimit: 500, timeLimit: 15 });
        return searchEntries.map((e) => String(e.dn || "")).filter(Boolean);
      });
      for (const g of found) groups.add(g);
    } catch {
      /* memberOf is already collected */
    }
  }

  return {
    dn: userDn,
    username,
    displayName: firstString((entry as Record<string, unknown>)[s.displayNameAttr]),
    email: firstString((entry as Record<string, unknown>)[s.emailAttr]),
    ldapUid: extractUid(entry, idAttr) || userDn.toLowerCase(),
    groups: [...groups],
  };
}

export async function findOrProvisionLdapUser(result: LdapAuthResult) {
  return provisionExternalUser({
    provider: "ldap",
    externalIdField: "ldapUid",
    externalId: result.ldapUid,
    usernameHint: result.username,
    displayName: result.displayName || null,
    email: result.email || null,
    groups: result.groups,
  });
}

/** Admin "Test": the service-account bind works and the search base resolves. */
export async function testLdapConnection(): Promise<{ ok: boolean; message: string }> {
  const s = await getLdapSettings();
  if (!s.url) return { ok: false, message: "Server URL is required" };
  if (!s.bindDn) return { ok: false, message: "Bind DN is required" };
  if (!s.bindPassword) return { ok: false, message: "Bind password is required" };
  if (!s.searchBase) return { ok: false, message: "Search base is required" };
  try {
    const count = await withBoundLdapClient(connConfig(s, s.bindDn, openSettingSecret(s.bindPassword)), undefined, async (c) => {
      const { searchEntries } = await c.search(s.searchBase, { scope: "base", filter: "(objectClass=*)", attributes: ["dn"], sizeLimit: 1, timeLimit: 10 });
      return searchEntries.length;
    });
    return { ok: true, message: `Connected — service bind succeeded, search base resolved (${count} entry).` };
  } catch (err) {
    return { ok: false, message: formatLdapError(err) };
  }
}

/** Test hook. */
export function resetLdapForTests(): void {
  store.invalidate();
}
