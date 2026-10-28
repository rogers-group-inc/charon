/**
 * src/services/activeDirectoryService.ts — On-premise Active Directory discovery
 *
 * Authenticates to a domain controller via LDAP simple bind (LDAP or LDAPS) and
 * reads, under the configured base DN:
 *   - computer objects (`discoverDevices`, ported verbatim from polaris — paged,
 *     capped, with the disappearance-sweep completeness tracking), and
 *   - users / groups / OUs (`discoverDirectory`, Charon — the ZTNA tag sources:
 *     a user's `memberOf` DNs drive `directory_group` tags, its DN the
 *     `directory_ou` tags).
 * Strictly read-only — Charon never writes to AD. Business-rule numbers in the
 * ported comments (35, 70) are POLARIS rules.
 */

import { type Entry, type SearchOptions } from "ldapts";
import { AppError } from "../utils/errors.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { withBoundLdapClient, decodeObjectGuid, formatLdapError } from "./ldapClient.js";
import type { DiscoveredDirectoryObject } from "./directoryTypes.js";

export interface ActiveDirectoryConfig {
  host: string;
  port?: number;
  useLdaps?: boolean;
  verifyTls?: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  searchScope?: "sub" | "one";
  ouInclude?: string[];   // Wildcards match against distinguishedName (e.g. *OU=Servers*)
  ouExclude?: string[];
  includeDisabled?: boolean;  // Default true — disabled accounts are still mirrored (attributes.disabled)
  // No `decommissionMissing` (polaris's opt-in sweep): in Charon a directory
  // object that left the directory must lose its tags, so the mirror's sweep
  // always runs, behind the guards in discovery/directoryDiscovery → planSweep.
}

export interface DiscoveredAdDevice {
  objectGuid: string;           // Lowercase hex (stable AD identifier → Asset.assetTag = "ad:{guid}")
  objectSid: string;            // String SID (cross-link to Entra's onPremisesSecurityIdentifier)
  cn: string;                   // Short hostname
  dnsHostName: string;          // FQDN (preferred for Asset.hostname if present)
  distinguishedName: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  description: string;
  whenCreated?: string;         // ISO
  lastLogonTimestamp?: string;  // ISO (from Windows FILETIME); replicates only every ~14 days
  disabled: boolean;            // userAccountControl & 0x2 (ACCOUNTDISABLE)
  ouPath: string;               // Derived from DN, e.g. "OU=Workstations/OU=HQ"
}

export interface AdDiscoveryResult {
  devices: DiscoveredAdDevice[];
  /**
   * Every objectGUID the LDAP read returned, taken BEFORE `ouInclude` /
   * `ouExclude` and BEFORE the `includeDisabled=false` skip — the raw answer
   * to "what does the directory still hold?", which is the only honest input
   * to the disappearance sweep. `devices` is the filtered view and would read
   * an OU-filter edit as a deletion.
   */
  presentObjectGuids: string[];
  /** Of those, the ones carrying ACCOUNTDISABLE. */
  disabledObjectGuids: string[];
  /**
   * False when the read may be partial — cancelled mid-parse, or the
   * 10,000-object hard cap was reached. A partial read is indistinguishable
   * from a deleted fleet, so the sweep refuses on it.
   */
  inventoryComplete: boolean;
  /** True when the run was narrowed to one computer object ("Discover Now"). */
  scoped: boolean;
}

export type AdDiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
) => void;

// LDAP connection + bind lifecycle lives in ./ldapClient (shared with the
// LDAP user-auth path). withBoundLdapClient accepts our config structurally.

// ─── Connection test ────────────────────────────────────────────────────────

export async function testConnection(config: ActiveDirectoryConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!config.host)         return { ok: false, message: "Host is required" };
  if (!config.bindDn)       return { ok: false, message: "Bind DN is required" };
  if (!config.bindPassword) return { ok: false, message: "Bind password is required" };
  if (!config.baseDn)       return { ok: false, message: "Base DN is required" };

  try {
    const count = await withBoundLdapClient(config, undefined, async (client) => {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: config.searchScope || "sub",
        filter: "(&(objectCategory=computer)(objectClass=computer))",
        attributes: ["cn"],
        sizeLimit: 1,
        timeLimit: 10,
      });
      return searchEntries.length;
    });
    return { ok: true, message: `Connected — bind succeeded, sample computer query returned ${count} entry(s)` };
  } catch (err: any) {
    return { ok: false, message: formatLdapError(err) };
  }
}

/**
 * Run an arbitrary LDAP search against the configured DC using stored
 * credentials. baseDn defaults to the integration's configured base.
 * Returns plain objects with Buffer attributes stringified where possible.
 */
export async function proxyQuery(
  config: ActiveDirectoryConfig,
  body: { filter?: string; baseDn?: string; scope?: "sub" | "one" | "base"; attributes?: string[]; sizeLimit?: number },
): Promise<unknown> {
  const filter = body.filter?.trim() || "(&(objectCategory=computer)(objectClass=computer))";
  const baseDn = body.baseDn?.trim() || config.baseDn;
  if (!baseDn) throw new AppError(400, "baseDn is required (either in the query or the integration config)");

  const size = Math.min(Math.max(body.sizeLimit || 50, 1), 500);
  const attrs = body.attributes && body.attributes.length > 0 ? body.attributes : undefined;

  return withBoundLdapClient(config, undefined, async (client) => {
    const { searchEntries } = await client.search(baseDn, {
      scope: body.scope || "sub",
      filter,
      attributes: attrs,
      sizeLimit: size,
      timeLimit: 15,
    });
    return { entries: searchEntries.map(simplifyEntry) };
  });
}

function simplifyEntry(entry: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = { dn: entry.dn };
  for (const key of Object.keys(entry)) {
    if (key === "dn") continue;
    const v = (entry as any)[key];
    if (Buffer.isBuffer(v)) {
      out[key] = v.toString("utf8");
    } else if (Array.isArray(v) && v.length > 0 && Buffer.isBuffer(v[0])) {
      out[key] = (v as Buffer[]).map((b) => b.toString("utf8"));
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ─── Device discovery ───────────────────────────────────────────────────────

const DEVICES_HARD_CAP = 10_000;
const PAGE_SIZE = 1000;

const ATTRIBUTES = [
  "objectGUID",
  "objectSid",
  "cn",
  "dNSHostName",
  "distinguishedName",
  "operatingSystem",
  "operatingSystemVersion",
  "description",
  "whenCreated",
  "lastLogonTimestamp",
  "userAccountControl",
];

// Attributes that must come back as raw bytes so we can decode them ourselves.
const BUFFER_ATTRIBUTES = ["objectGUID", "objectSid"];

export async function discoverDevices(
  config: ActiveDirectoryConfig,
  signal?: AbortSignal,
  onProgress?: AdDiscoveryProgressCallback,
): Promise<AdDiscoveryResult> {
  const log = onProgress || (() => {});

  if (!config.host)         throw new AppError(400, "Host is required");
  if (!config.bindDn)       throw new AppError(400, "Bind DN is required");
  if (!config.bindPassword) throw new AppError(400, "Bind password is required");
  if (!config.baseDn)       throw new AppError(400, "Base DN is required");

  // Charon has no single-object "Discover Now" — polaris's GUID-scoped run is
  // not carried, so every run is a whole read (`scoped` is always false).
  const devices: DiscoveredAdDevice[] = [];
  // Completeness, tracked rather than inferred: the parse loop below breaks on
  // cancellation and the search is capped, and both produce a short list that
  // looks exactly like a directory somebody emptied.
  let aborted = false;
  let capped = false;

  try {
    await withBoundLdapClient(config, signal, async (client) => {
      const options: SearchOptions = {
        scope: config.searchScope || "sub",
        filter: "(&(objectCategory=computer)(objectClass=computer))",
        attributes: ATTRIBUTES,
        explicitBufferAttributes: BUFFER_ATTRIBUTES,
        paged: { pageSize: PAGE_SIZE },
        sizeLimit: DEVICES_HARD_CAP,
        timeLimit: 120,
      };
      const { searchEntries } = await client.search(config.baseDn, options);
      capped = searchEntries.length >= DEVICES_HARD_CAP;

      for (const entry of searchEntries) {
        if (signal?.aborted) { aborted = true; break; }
        const dev = parseEntry(entry);
        if (!dev) continue;
        devices.push(dev);
      }
    });
  } catch (err: any) {
    const msg = formatLdapError(err);
    log("discover.ad.search", "error", `Active Directory: search failed — ${msg}`);
    throw new AppError(502, `Active Directory search failed: ${msg}`);
  }

  log("discover.ad.search", "info", `Active Directory: retrieved ${devices.length} computer object(s)`);

  // Snapshot the RAW read for the disappearance sweep before either exclusion
  // below narrows it — see the AdDiscoveryResult docblock.
  const absence = {
    presentObjectGuids: devices.map((d) => d.objectGuid),
    disabledObjectGuids: devices.filter((d) => d.disabled).map((d) => d.objectGuid),
    inventoryComplete: !aborted && !capped,
    scoped: false,
  };
  if (capped) {
    log("discover.ad.search", "error", `Active Directory: hit the ${DEVICES_HARD_CAP}-object cap — the read is partial and the disappearance sweep will be skipped`);
  }

  const filtered = filterDevices(devices, config.ouInclude, config.ouExclude);
  const dropped = devices.length - filtered.length;
  if (dropped > 0) {
    log("discover.filter", "info", `Device filter: ${filtered.length} included, ${dropped} excluded`);
  }

  if (config.includeDisabled === false) {
    const beforeDisabled = filtered.length;
    const active = filtered.filter((d) => !d.disabled);
    const disabledCount = beforeDisabled - active.length;
    if (disabledCount > 0) {
      log("discover.filter.disabled", "info", `Skipping ${disabledCount} disabled computer account(s) (includeDisabled=false)`);
    }
    return { devices: active, ...absence };
  }

  return { devices: filtered, ...absence };
}

/**
 * Should the disappearance sweep run against this result?
 *
 * Absence is only evidence of deletion when the read was whole. Returns the
 * reason to skip, or null when the read can be trusted. Mirrors
 * `vcenterService.vcenterSweepBlockedReason`, scoped-run check first so an
 * operator is told the real reason rather than a plausible wrong one.
 */
export function adSweepBlockedReason(
  result: Pick<AdDiscoveryResult, "presentObjectGuids" | "inventoryComplete" | "scoped">,
): string | null {
  if (result.scoped) return "the run was scoped to a single computer object";
  if (!result.inventoryComplete) return `the directory read was incomplete (cancelled, or the ${DEVICES_HARD_CAP}-object cap was reached)`;
  // Zero computer objects under a baseDn that previously held a fleet is a
  // bind/permission/baseDn answer far more often than an emptied domain —
  // business rule 35's shrunken-read reasoning, same as vCenter's.
  if (result.presentObjectGuids.length === 0) return "the directory read came back empty";
  return null;
}

// ─── Directory (tag-source) discovery — Charon ──────────────────────────────

/** Per-kind cap on users / groups / OUs, like DEVICES_HARD_CAP for computers. */
export const DIRECTORY_HARD_CAP = 50_000;

const USER_ATTRIBUTES = [
  "objectGUID", "distinguishedName", "userPrincipalName", "sAMAccountName",
  "displayName", "mail", "department", "memberOf", "userAccountControl",
];
const GROUP_ATTRIBUTES = ["objectGUID", "distinguishedName", "cn", "description"];
const OU_ATTRIBUTES = ["objectGUID", "distinguishedName", "ou"];

export interface AdDirectoryResult {
  objects: DiscoveredDirectoryObject[];
  /**
   * False when any of the three reads may be partial (cancelled, or a kind hit
   * DIRECTORY_HARD_CAP). The directory mirror's removal sweep refuses on it —
   * a short read is indistinguishable from deleted users.
   */
  complete: boolean;
}

/**
 * Users, groups and OUs under the base DN — the ZTNA tag sources. Every search
 * is PAGED (AD's default MaxPageSize is 1000: an unpaged search silently stops
 * there) and capped per kind. `ouInclude` / `ouExclude` narrow users and groups
 * by DN, as they narrow computers. Disabled users are kept with
 * `attributes.disabled = true` unless `includeDisabled` is false.
 */
export async function discoverDirectory(
  config: ActiveDirectoryConfig,
  signal?: AbortSignal,
  onProgress?: AdDiscoveryProgressCallback,
): Promise<AdDirectoryResult> {
  const log = onProgress || (() => {});
  if (!config.host)         throw new AppError(400, "Host is required");
  if (!config.bindDn)       throw new AppError(400, "Bind DN is required");
  if (!config.bindPassword) throw new AppError(400, "Bind password is required");
  if (!config.baseDn)       throw new AppError(400, "Base DN is required");

  const objects: DiscoveredDirectoryObject[] = [];
  let complete = true;
  const inScope = (dn: string): boolean => {
    if (config.ouInclude && config.ouInclude.length > 0) return config.ouInclude.some((p) => matchesWildcard(p, dn));
    if (config.ouExclude && config.ouExclude.length > 0) return !config.ouExclude.some((p) => matchesWildcard(p, dn));
    return true;
  };

  try {
    await withBoundLdapClient(config, signal, async (client) => {
      const search = async (filter: string, attributes: string[]): Promise<Entry[]> => {
        const { searchEntries } = await client.search(config.baseDn, {
          scope: config.searchScope || "sub",
          filter,
          attributes,
          explicitBufferAttributes: ["objectGUID"],
          paged: { pageSize: PAGE_SIZE },
          sizeLimit: DIRECTORY_HARD_CAP,
          timeLimit: 120,
        });
        if (searchEntries.length >= DIRECTORY_HARD_CAP) complete = false;
        return searchEntries;
      };

      for (const e of await search("(&(objectCategory=person)(objectClass=user))", USER_ATTRIBUTES)) {
        if (signal?.aborted) { complete = false; return; }
        const dn = e.dn || readString(e.distinguishedName);
        const guid = guidOf(e);
        if (!guid || !inScope(dn)) continue;
        const disabled = (parseInt(readString(e.userAccountControl) || "0", 10) & 0x2) === 0x2;
        if (disabled && config.includeDisabled === false) continue;
        objects.push({
          kind: "user",
          externalId: guid,
          name: readString(e.displayName) || readString(e.sAMAccountName),
          identifier: readString(e.userPrincipalName) || readString(e.sAMAccountName) || undefined,
          parentOu: dn.replace(/^.*?(?<!\\),/, "") || undefined,
          attributes: {
            dn,
            sAMAccountName: readString(e.sAMAccountName) || undefined,
            department: readString(e.department) || undefined,
            mail: readString(e.mail) || undefined,
            memberOf: ([] as unknown[]).concat(e.memberOf ?? []).map((v) => readString(v)).filter(Boolean),
            disabled,
          },
        });
      }

      for (const e of await search("(objectClass=group)", GROUP_ATTRIBUTES)) {
        if (signal?.aborted) { complete = false; return; }
        const dn = e.dn || readString(e.distinguishedName);
        const guid = guidOf(e);
        if (!guid || !inScope(dn)) continue;
        objects.push({
          kind: "group",
          externalId: guid,
          name: readString(e.cn),
          identifier: dn,
          attributes: { description: readString(e.description) || undefined },
        });
      }

      for (const e of await search("(objectClass=organizationalUnit)", OU_ATTRIBUTES)) {
        if (signal?.aborted) { complete = false; return; }
        const dn = e.dn || readString(e.distinguishedName);
        const guid = guidOf(e);
        if (!guid) continue;
        objects.push({ kind: "ou", externalId: guid, name: readString(e.ou), identifier: dn, attributes: {} });
      }
    });
  } catch (err: any) {
    const msg = formatLdapError(err);
    log("discover.ad.directory", "error", `Active Directory: directory search failed — ${msg}`);
    throw new AppError(502, `Active Directory search failed: ${msg}`);
  }

  const counts = { user: 0, group: 0, ou: 0 } as Record<string, number>;
  for (const o of objects) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  log("discover.ad.directory", "info", `Active Directory: ${counts.user} user(s), ${counts.group} group(s), ${counts.ou} OU(s)`);
  if (!complete) log("discover.ad.directory", "error", `Active Directory: the directory read was partial (cancelled, or the ${DIRECTORY_HARD_CAP}-object cap was reached) — removals will be skipped`);
  return { objects, complete };
}

/** objectGUID as lowercase hex; "" for a missing or all-zero GUID (half-provisioned objects). */
function guidOf(entry: Entry): string {
  const raw = entry.objectGUID;
  const guid = Buffer.isBuffer(raw) ? decodeObjectGuid(raw) : Array.isArray(raw) && Buffer.isBuffer(raw[0]) ? decodeObjectGuid(raw[0]) : "";
  return guid && !/^0+$/.test(guid) ? guid : "";
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

function parseEntry(entry: Entry): DiscoveredAdDevice | null {
  const guidRaw = entry.objectGUID;
  const sidRaw = entry.objectSid;
  const guid = Buffer.isBuffer(guidRaw) ? decodeObjectGuid(guidRaw) : "";
  const sid = Buffer.isBuffer(sidRaw) ? decodeObjectSid(sidRaw) : "";
  // Reject empty or all-zero GUIDs (32 hex zeros). The latter shows up on
  // half-provisioned computer objects and would otherwise produce an asset
  // tagged "ad:00000000000000000000000000000000" that collides with every
  // other broken entry.
  if (!guid || /^0+$/.test(guid)) return null;

  const cn = readString(entry.cn);
  const dnsHostName = readString(entry.dNSHostName);
  const distinguishedName = entry.dn || readString(entry.distinguishedName);
  const os = readString(entry.operatingSystem);
  const osVersion = readString(entry.operatingSystemVersion);
  const description = readString(entry.description);
  const whenCreated = decodeGeneralizedTime(readString(entry.whenCreated));
  const lastLogon = decodeFileTime(readString(entry.lastLogonTimestamp));
  const uac = parseInt(readString(entry.userAccountControl) || "0", 10);
  const disabled = (uac & 0x2) === 0x2;
  const ouPath = deriveOuPath(distinguishedName);

  return {
    objectGuid: guid,
    objectSid: sid,
    cn,
    dnsHostName,
    distinguishedName,
    operatingSystem: os,
    operatingSystemVersion: osVersion,
    description,
    whenCreated,
    lastLogonTimestamp: lastLogon,
    disabled,
    ouPath,
  };
}

function readString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return readString(v[0]);
  return String(v);
}

// decodeObjectGuid lives in ./ldapClient (shared with LDAP user-auth).

// objectSid is a binary SID structure. Decode to the standard S-1-<auth>-<sub>...
// string form.
function decodeObjectSid(buf: Buffer): string {
  if (buf.length < 8) return "";
  const revision = buf.readUInt8(0);
  const subAuthCount = buf.readUInt8(1);
  // identifierAuthority is a 48-bit big-endian integer
  const authority =
    buf.readUIntBE(2, 6); // safe for values up to 2^48
  const parts: string[] = [`S-${revision}-${authority}`];
  for (let i = 0; i < subAuthCount; i++) {
    const offset = 8 + i * 4;
    if (offset + 4 > buf.length) break;
    parts.push(String(buf.readUInt32LE(offset)));
  }
  return parts.join("-");
}

// AD Generalized Time: "YYYYMMDDHHMMSS.0Z" → ISO string
function decodeGeneralizedTime(s: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Windows FILETIME: 100-nanosecond intervals since 1601-01-01 UTC → ISO string.
// AD returns "0" for never-logged-on, which we treat as undefined.
function decodeFileTime(s: string): string | undefined {
  if (!s || s === "0") return undefined;
  // Use BigInt to preserve precision; epoch offset is 11644473600 seconds.
  let n: bigint;
  try { n = BigInt(s); } catch { return undefined; }
  if (n <= 0n) return undefined;
  const ms = Number(n / 10000n) - 11644473600000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// "CN=FOO,OU=Workstations,OU=HQ,DC=corp,DC=local" → "OU=HQ/OU=Workstations"
// (outer→inner so a human reads the containment top-down).
function deriveOuPath(dn: string): string {
  if (!dn) return "";
  const parts = dn.split(/(?<!\\),/).map((p) => p.trim());
  const ous = parts.filter((p) => p.toUpperCase().startsWith("OU="));
  return ous.reverse().join("/");
}

// matchesWildcard is imported from ../utils/integrationFilter.js — the
// canonical glob-lite matcher shared by every device/VM/interface filter.

function filterDevices(
  devices: DiscoveredAdDevice[],
  include?: string[],
  exclude?: string[],
): DiscoveredAdDevice[] {
  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchesWildcard(p, d.distinguishedName)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchesWildcard(p, d.distinguishedName)));
  }
  return devices;
}
