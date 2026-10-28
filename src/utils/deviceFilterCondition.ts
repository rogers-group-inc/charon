/**
 * src/utils/deviceFilterCondition.ts — the asset-tag auto-assign device filter.
 *
 * Ported from polaris services/notificationTypes.ts (the DEVICE_FILTER half of
 * the condition-tree vocabulary): the field/operator map, the zod schema that
 * validates a posted tree, the depth/size guard, and the builder catalog the
 * shared condition builder (public/js/condition-builder.js) renders from.
 *
 * Pure — no DB. Charon has no asset inventory, so nothing EVALUATES these
 * trees yet: a tag's filter is validated and stored exactly as polaris does,
 * and the preview reports zero matches. When charon Endpoints become taggable,
 * an evaluator over endpoint rows plugs in behind tagFilterPreview().
 */

import { z } from "zod";
import { isIP } from "node:net";

export const SCOPE_GROUP_OPS = ["and", "or", "none", "notAll"] as const;
export type ScopeGroupOp = (typeof SCOPE_GROUP_OPS)[number];

const STRING_OPS = ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"] as const;
const SUBNET_NAME_OPS = ["inSubnetNamed", "notInSubnetNamed"] as const;
const SUBNET_RANGE_OPS = ["inRange", "notInRange"] as const;
const SUBNET_OPS = ["inCidr", "notInCidr", ...SUBNET_RANGE_OPS, ...SUBNET_NAME_OPS] as const;
const WILDCARD_OP = "matches";
const STRING_OPS_WITH_WILDCARD = [...STRING_OPS, WILDCARD_OP] as const;

/** Polaris SCOPE_FIELD_OPS (the automations scope vocabulary). */
const SCOPE_FIELD_OPS: Record<string, readonly string[]> = {
  assetType: ["equals", "notEquals"],
  manufacturer: STRING_OPS,
  model: STRING_OPS,
  hostname: STRING_OPS,
  os: STRING_OPS,
  tag: ["has", "notHas"],
  subnet: SUBNET_OPS,
  ipBlock: ["inCidr", "notInCidr"],
  interfaceName: STRING_OPS,
  ssid: STRING_OPS,
  agentInstalled: ["equals", "notEquals"],
  status: ["equals", "notEquals"],
  assetId: ["equals", "notEquals"],
};

/**
 * The DEVICE-FILTER vocabulary: the scope fields with the wildcard added to
 * every free-string field, plus the four fields the flat tag builder carried.
 */
export const DEVICE_FILTER_FIELD_OPS: Record<string, readonly string[]> = {
  ...Object.fromEntries(
    Object.entries(SCOPE_FIELD_OPS).map(([field, ops]) => [
      field,
      ops.includes("contains") ? STRING_OPS_WITH_WILDCARD : ops,
    ]),
  ),
  osVersion: STRING_OPS_WITH_WILDCARD,
  department: STRING_OPS_WITH_WILDCARD,
  location: STRING_OPS_WITH_WILDCARD,
  fortigate: STRING_OPS_WITH_WILDCARD,
  nativeVlan: ["equals", "notEquals"],
};

export interface ScopeConditionRule {
  field: string;
  operator: string;
  value: string;
}
export interface ScopeConditionGroup {
  op: ScopeGroupOp;
  children: (ScopeConditionGroup | ScopeConditionRule)[];
}

export const SCOPE_CONDITION_MAX_DEPTH = 5;
export const SCOPE_CONDITION_MAX_RULES = 100;
const MAX_PATTERN_LENGTH = 512;
const CIDR_VALUED_FIELDS = new Set(["subnet", "ipBlock"]);

// ─── Value validators (polaris utils/cidr.ts + utils/wildcard.ts) ───────────

function isValidIpv4(ip: string): boolean {
  return isIP(ip) === 4;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
}

/** "10.0.0.10-10.0.0.50" or "10.0.0.10-50", first ≤ last. */
export function parseIpv4Range(raw: string): { first: string; last: string } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(/\s*-\s*/);
  if (parts.length < 1 || parts.length > 2) return null;
  const first = parts[0] ?? "";
  let last = parts[1] ?? first;
  if (/^\d{1,3}$/.test(last)) last = first.split(".").slice(0, 3).concat(last).join(".");
  if (!isValidIpv4(first) || !isValidIpv4(last)) return null;
  if (ipv4ToInt(first) > ipv4ToInt(last)) return null;
  return { first, last };
}

/** IPv4 "a.b.c.d/n" (0-32) or IPv6 "x::/n" (0-128). */
export function isValidCidr(cidr: string): boolean {
  if (typeof cidr !== "string") return false;
  const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
  if (!m) return false;
  const v = isIP(m[1]!);
  const bits = Number(m[2]);
  if (v === 4) return bits <= 32;
  if (v === 6) return bits <= 128;
  return false;
}

export function parseVlanId(raw: string | null | undefined): number | null {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 4094 ? n : null;
}

/** Shell-style wildcard sanity (polaris compileWildcard's write-time checks). */
function wildcardProblem(pattern: string): string | null {
  if (pattern.length === 0) return "Empty wildcard pattern";
  if (pattern.length > MAX_PATTERN_LENGTH) return `Wildcard pattern exceeds ${MAX_PATTERN_LENGTH} characters`;
  return null;
}

// ─── Schema ────────────────────────────────────────────────────────────────

function makeScopeConditionSchema(fieldOps: Record<string, readonly string[]>): z.ZodType<ScopeConditionGroup> {
  const ruleSchema = z
    .object({
      field: z.enum(Object.keys(fieldOps) as [string, ...string[]]),
      operator: z.string().min(1).max(30),
      value: z.string().min(1).max(200),
    })
    .strict()
    .superRefine((r, ctx) => {
      const ops = fieldOps[r.field] ?? [];
      if (!ops.includes(r.operator)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `operator "${r.operator}" is not valid for field "${r.field}"` });
      }
      if ((SUBNET_RANGE_OPS as readonly string[]).includes(r.operator)) {
        if (!parseIpv4Range(r.value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be an IPv4 range, first to last (e.g. 10.20.0.10-10.20.0.50)` });
        }
      } else if ((SUBNET_NAME_OPS as readonly string[]).includes(r.operator)) {
        const p = wildcardProblem(r.value.trim());
        if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p });
      } else if (CIDR_VALUED_FIELDS.has(r.field) && !isValidCidr(r.value) && isIP(r.value) === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be a CIDR (e.g. 10.20.0.0/16) or an IP address` });
      } else if (r.field === "nativeVlan" && parseVlanId(r.value) == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be a VLAN number from 1 to 4094` });
      }
      if (r.operator === WILDCARD_OP) {
        const p = wildcardProblem(r.value);
        if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p });
      }
    });

  const groupSchema: z.ZodType<ScopeConditionGroup> = z.lazy(() =>
    z
      .object({
        op: z.enum(SCOPE_GROUP_OPS),
        children: z.array(z.union([ruleSchema, groupSchema])).max(50),
      })
      .strict(),
  ) as z.ZodType<ScopeConditionGroup>;
  return groupSchema;
}

/** The tag device filter — the tree over DEVICE_FILTER_FIELD_OPS. */
export const deviceFilterConditionSchema: z.ZodType<ScopeConditionGroup> =
  makeScopeConditionSchema(DEVICE_FILTER_FIELD_OPS);

/** Depth/size guard for a condition tree (defense against pathological input). */
export function scopeConditionStats(cond: ScopeConditionGroup): { depth: number; rules: number } {
  let rules = 0;
  const depthOf = (g: ScopeConditionGroup): number =>
    1 + Math.max(0, ...g.children.map((c) => {
      if ("op" in c) return depthOf(c as ScopeConditionGroup);
      rules++;
      return 0;
    }));
  const depth = depthOf(cond);
  return { depth, rules };
}

// ─── Builder catalog ───────────────────────────────────────────────────────

const SCOPE_FIELD_META: Record<string, { label: string; optionsFrom: string | null; values?: string[] }> = {
  assetType: { label: "Device type", optionsFrom: "assetTypes" },
  manufacturer: { label: "Manufacturer", optionsFrom: "manufacturers" },
  model: { label: "Model", optionsFrom: "models" },
  hostname: { label: "Hostname", optionsFrom: null },
  os: { label: "Operating system", optionsFrom: null },
  tag: { label: "Tag", optionsFrom: "tags" },
  subnet: { label: "Subnet / IP", optionsFrom: "subnets" },
  ipBlock: { label: "IP block", optionsFrom: "ipBlocks" },
  interfaceName: { label: "Device interface", optionsFrom: "interfaceNames" },
  ssid: { label: "Broadcast SSID", optionsFrom: "ssids" },
  // Charon adaptation: rebranded from "Polaris Agent installed".
  agentInstalled: { label: "Charon Agent installed", optionsFrom: null, values: ["yes", "no"] },
  status: {
    label: "Lifecycle status",
    optionsFrom: null,
    values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"],
  },
  osVersion: { label: "OS version", optionsFrom: null },
  department: { label: "Department", optionsFrom: null },
  location: { label: "Location", optionsFrom: null },
  fortigate: { label: "Behind FortiGate", optionsFrom: null },
  nativeVlan: { label: "Native VLAN", optionsFrom: "nativeVlans" },
  // `assetId` stays valid for stored rules but is not offered as a builder choice.
};

/** The builder catalog for the device-filter vocabulary (polaris scopeConditionMeta). */
export function deviceFilterConditionMeta() {
  const fieldOps = DEVICE_FILTER_FIELD_OPS;
  return {
    groupOps: SCOPE_GROUP_OPS,
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    operatorLabels: {
      equals: "is equal to",
      notEquals: "is not equal to",
      contains: "contains",
      notContains: "does not contain",
      startsWith: "starts with",
      endsWith: "ends with",
      has: "is applied",
      notHas: "is not applied",
      inCidr: "is within CIDR",
      notInCidr: "is not within CIDR",
      inRange: "is within range",
      notInRange: "is not within range",
      inSubnetNamed: "is in subnet named",
      notInSubnetNamed: "is not in subnet named",
      [WILDCARD_OP]: "matches (wildcard *)",
    },
    operatorValueKinds: {
      inCidr: "cidr",
      notInCidr: "cidr",
      inRange: "ipRange",
      notInRange: "ipRange",
      inSubnetNamed: "subnetName",
      notInSubnetNamed: "subnetName",
    },
    fields: Object.keys(fieldOps)
      .filter((field) => SCOPE_FIELD_META[field])
      .map((field) => ({
        field,
        label: SCOPE_FIELD_META[field]!.label,
        ops: fieldOps[field],
        optionsFrom: SCOPE_FIELD_META[field]!.optionsFrom,
        ...(SCOPE_FIELD_META[field]!.values ? { values: SCOPE_FIELD_META[field]!.values } : {}),
      })),
    maxDepth: SCOPE_CONDITION_MAX_DEPTH,
    maxRules: SCOPE_CONDITION_MAX_RULES,
  };
}
