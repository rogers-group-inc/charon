/**
 * src/services/activeDirectoryService.ts — On-prem AD (LDAP) directory source.
 *
 * Read-only discovery of users / groups / OUs that become ZTNA tag sources.
 * Binds with a service account, searches under the configured base DN, and
 * normalizes results to DiscoveredDirectoryObject. All filter values are
 * RFC-4515 escaped (see ldapClient). Discovery is strictly read-only — Charon
 * never writes to AD.
 */

import { withBoundLdapClient, decodeObjectGuid, escapeLdapFilterValue, formatLdapError } from "./ldapClient.js";
import type { TestResult } from "./integrationService.js";
import type { DiscoveredDirectoryObject } from "./directoryTypes.js";

export interface ActiveDirectoryConfig {
  host: string;
  port?: number;
  useLdaps?: boolean;
  verifyTls?: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
}

const USER_ATTRS = ["objectGUID", "userPrincipalName", "sAMAccountName", "displayName", "mail", "memberOf", "department", "distinguishedName"];
const GROUP_ATTRS = ["objectGUID", "cn", "distinguishedName", "description"];
const OU_ATTRS = ["objectGUID", "ou", "distinguishedName"];

export async function testConnection(config: ActiveDirectoryConfig, signal?: AbortSignal): Promise<TestResult> {
  try {
    const count = await withBoundLdapClient(config, signal, async (client) => {
      const { searchEntries } = await client.search(config.baseDn, {
        scope: "base",
        filter: "(objectClass=*)",
        attributes: ["distinguishedName"],
      });
      return searchEntries.length;
    });
    return { ok: true, message: `Bound successfully; base DN reachable (${count} root entry)` };
  } catch (err: any) {
    return { ok: false, message: formatLdapError(err) };
  }
}

function getStr(entry: any, key: string): string | undefined {
  const v = entry[key];
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return v !== undefined && v !== null ? String(v) : undefined;
}

function guidOf(entry: any): string {
  const raw = entry.objectGUID;
  if (Buffer.isBuffer(raw)) return decodeObjectGuid(raw);
  if (Array.isArray(raw) && Buffer.isBuffer(raw[0])) return decodeObjectGuid(raw[0]);
  return getStr(entry, "distinguishedName") ?? "";
}

export async function discover(config: ActiveDirectoryConfig, signal?: AbortSignal): Promise<DiscoveredDirectoryObject[]> {
  return withBoundLdapClient(config, signal, async (client) => {
    const out: DiscoveredDirectoryObject[] = [];

    const users = await client.search(config.baseDn, {
      scope: "sub",
      filter: "(&(objectCategory=person)(objectClass=user))",
      attributes: USER_ATTRS,
    });
    for (const e of users.searchEntries) {
      out.push({
        kind: "user",
        externalId: guidOf(e),
        name: getStr(e, "displayName") || getStr(e, "sAMAccountName") || "",
        identifier: getStr(e, "userPrincipalName") || getStr(e, "sAMAccountName"),
        parentOu: getStr(e, "distinguishedName")?.replace(/^.*?,/, ""),
        attributes: {
          department: getStr(e, "department"),
          mail: getStr(e, "mail"),
          memberOf: ([] as string[]).concat((e.memberOf as any) ?? []).map(String),
        },
      });
    }

    const groups = await client.search(config.baseDn, {
      scope: "sub",
      filter: "(objectClass=group)",
      attributes: GROUP_ATTRS,
    });
    for (const e of groups.searchEntries) {
      out.push({
        kind: "group",
        externalId: guidOf(e),
        name: getStr(e, "cn") || "",
        identifier: getStr(e, "distinguishedName"),
        attributes: { description: getStr(e, "description") },
      });
    }

    const ous = await client.search(config.baseDn, {
      scope: "sub",
      filter: "(objectClass=organizationalUnit)",
      attributes: OU_ATTRS,
    });
    for (const e of ous.searchEntries) {
      out.push({
        kind: "ou",
        externalId: guidOf(e),
        name: getStr(e, "ou") || "",
        identifier: getStr(e, "distinguishedName"),
        attributes: {},
      });
    }

    return out;
  });
}

// Suppress unused-import lint for the escape helper retained for filtered
// searches added in the tag milestone.
void escapeLdapFilterValue;
