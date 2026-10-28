/**
 * src/services/platformLifecycleService.ts — the Platform Lifecycle card.
 *
 * Ported from polaris (src/services/platformLifecycleService.ts +
 * src/utils/platformLifecycleGrade.ts): what this host runs, graded against
 * the committed, human-reviewed end-of-life dataset.
 *
 * Charon adaptations:
 *  - The dataset is Charon's own `scripts/data/platformEol.json` (owned by the
 *    charon-tech-lifecycle skill; schema charonMinimum / charonTarget / tracks).
 *    Read at request time, memoised 6h. If it is missing or malformed the card
 *    renders `datasetError` instead of a silently empty table.
 *  - Components: Node.js (this process), PostgreSQL (SHOW server_version) and
 *    OpenSSL (the `openssl` CLI, i.e. what nginx's TLS 1.3 / ML-KEM hybrid KEX
 *    uses; falls back to Node's bundled OpenSSL with a note).
 *  - No playbooks, security floors or extended-support dates in the Charon
 *    dataset yet; the grader honours them if they are added.
 *  - Never records a transition (no Event) — a page refresh must not spam.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { getAppVersion } from "../utils/version.js";
import { getManifest } from "./agentDistService.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATASET_PATH = resolve(PROJECT_ROOT, "scripts", "data", "platformEol.json");

export const LIFECYCLE_WATCH_DAYS = 180;
export const LIFECYCLE_WARNING_DAYS = 90;
const DAY_MS = 86_400_000;

export interface PlatformTrack {
  track: string;
  released?: string;
  eol?: string | null;
  extendedSupport?: string | null;
  supported?: boolean;
  lts?: boolean;
  securityFloor?: { version: string; advisories: Array<{ id: string; severity: string }>; source?: string };
}

export interface PlatformTechnology {
  id: string;
  label: string;
  charonMinimum?: string | null;
  charonTarget?: string | null;
  source?: string;
  confidence?: string;
  notes?: string;
  tracks: PlatformTrack[];
}

export interface PlatformEolDataset {
  schemaVersion: number;
  reviewedAt: string;
  technologies: PlatformTechnology[];
}

export type LifecycleState =
  | "unknown" | "not_installed" | "current" | "aging" | "behind_target"
  | "approaching_eol" | "unpatched" | "eol_extended" | "eol" | "below_minimum";
export type LifecycleSeverity = "none" | "watch" | "warning" | "critical";

export interface LifecycleGrade {
  state: LifecycleState;
  severity: LifecycleSeverity;
  track: string | null;
  eolAt: string | null;
  daysUntilEol: number | null;
  securityFloor?: PlatformTrack["securityFloor"];
}

/** Track granularity per technology: OpenSSL lines are major.minor. */
const GRANULARITY: Record<string, "major" | "major.minor"> = { openssl: "major.minor" };

/** "20.18.1" → "20" (major) or "3.5.1" → "3.5" (major.minor). */
export function deriveTrack(version: string | null, granularity: "major" | "major.minor"): string | null {
  if (!version) return null;
  const m = version.trim().match(/^v?(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  if (granularity === "major") return m[1];
  return m[2] !== undefined ? `${m[1]}.${m[2]}` : null;
}

/** Numeric dotted compare ("3.10" > "3.9"). */
export function compareTracks(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Whole days from `now` (floored to UTC midnight) to a date-only ISO string. */
function daysBetween(nowMs: number, toIso: string): number {
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - midnight) / DAY_MS);
}

/** Pure: grade one observed component against its dataset entry. */
export function gradeComponent(tech: PlatformTechnology, observedVersion: string | null, now: Date, opts: { installed?: boolean } = {}): LifecycleGrade {
  const granularity = GRANULARITY[tech.id] ?? "major";
  const track = deriveTrack(observedVersion, granularity);
  const base: LifecycleGrade = { state: "unknown", severity: "none", track, eolAt: null, daysUntilEol: null };
  if (opts.installed === false) return { ...base, state: "not_installed" };
  if (!track) return base;

  const row = tech.tracks.find((t) => t.track === track) ?? null;
  const eolAt = row?.eol ?? null;
  const daysUntilEol = eolAt ? daysBetween(now.getTime(), eolAt) : null;
  const withDates = (over: Partial<LifecycleGrade>): LifecycleGrade => ({ ...base, eolAt, daysUntilEol, ...over });

  if (tech.charonMinimum && compareTracks(track, tech.charonMinimum) < 0) {
    return withDates({ state: "below_minimum", severity: "critical" });
  }
  if (!row) return base;

  // An explicit "no longer supported" with no date is still end of life.
  if ((daysUntilEol !== null && daysUntilEol < 0) || (row.supported === false && eolAt === null)) {
    if (row.extendedSupport && daysBetween(now.getTime(), row.extendedSupport) >= 0) {
      return withDates({ state: "eol_extended", severity: "warning" });
    }
    return withDates({ state: "eol", severity: "critical" });
  }
  if (row.securityFloor && observedVersion && compareTracks(observedVersion.replace(/^v/, ""), row.securityFloor.version) < 0) {
    return withDates({ state: "unpatched", severity: "critical", securityFloor: row.securityFloor });
  }
  if (daysUntilEol !== null && daysUntilEol <= LIFECYCLE_WARNING_DAYS) return withDates({ state: "approaching_eol", severity: "warning" });
  if (daysUntilEol !== null && daysUntilEol <= LIFECYCLE_WATCH_DAYS) return withDates({ state: "aging", severity: "watch" });
  if (tech.charonTarget && compareTracks(track, tech.charonTarget) < 0) return withDates({ state: "behind_target", severity: "watch" });
  return withDates({ state: "current", severity: "none" });
}

/** Minimal shape check — the dataset is committed and reviewed, so a broken
 *  one is a bug to surface, not to paper over. */
export function parseDataset(raw: unknown): PlatformEolDataset {
  const d = raw as PlatformEolDataset;
  if (!d || typeof d !== "object") throw new Error("dataset is not a JSON object");
  if (typeof d.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.reviewedAt)) throw new Error("dataset.reviewedAt must be YYYY-MM-DD");
  if (!Array.isArray(d.technologies) || d.technologies.length === 0) throw new Error("dataset.technologies is empty");
  for (const t of d.technologies) {
    if (!t?.id || !t.label || !Array.isArray(t.tracks)) throw new Error(`dataset technology ${t?.id ?? "?"} is malformed`);
  }
  return d;
}

export function loadPlatformEolDataset(path: string = DATASET_PATH): PlatformEolDataset {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    throw new Error("scripts/data/platformEol.json is not present in this install");
  }
  return parseDataset(JSON.parse(text));
}

// ─── Probes ──────────────────────────────────────────────────────────────────

export interface ObservedComponent {
  id: string;
  observedVersion: string | null;
  probeStatus: "ok" | "absent" | "error";
  probeNote?: string;
}

async function probePostgres(): Promise<ObservedComponent> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ server_version: string }[]>("SHOW server_version");
    const v = rows[0]?.server_version?.match(/^\d+(?:\.\d+)?/)?.[0] ?? null;
    return { id: "postgres", observedVersion: v, probeStatus: v ? "ok" : "error", probeNote: rows[0]?.server_version };
  } catch (err: any) {
    return { id: "postgres", observedVersion: null, probeStatus: "error", probeNote: err?.message };
  }
}

async function probeOpenssl(): Promise<ObservedComponent> {
  try {
    const { stdout } = await execFileAsync("openssl", ["version"], { timeout: 3000, windowsHide: true });
    const v = stdout.match(/OpenSSL\s+(\d+\.\d+\.\d+)/i)?.[1] ?? null;
    return { id: "openssl", observedVersion: v, probeStatus: v ? "ok" : "error", probeNote: stdout.trim() };
  } catch {
    const bundled = process.versions.openssl?.match(/^\d+\.\d+\.\d+/)?.[0] ?? null;
    return {
      id: "openssl",
      observedVersion: bundled,
      probeStatus: bundled ? "ok" : "absent",
      probeNote: "No openssl CLI on this host — showing the OpenSSL bundled with Node.js, not the one nginx links against.",
    };
  }
}

export async function observePlatformStack(): Promise<ObservedComponent[]> {
  const node: ObservedComponent = { id: "node", observedVersion: process.versions.node, probeStatus: "ok" };
  const [pg, ssl] = await Promise.all([probePostgres(), probeOpenssl()]);
  return [node, pg, ssl];
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export interface LifecycleComponent extends ObservedComponent {
  label: string;
  policy: "dated";
  polarisTarget: string | null; // the frontend's field name; holds charonTarget
  targetTrackEolAt: string | null;
  source: string | null;
  playbook: null;
  grade: LifecycleGrade;
}

export interface PlatformLifecycleResult {
  computedAt: string;
  datasetReviewedAt: string | null;
  datasetError: string | null;
  severity: LifecycleSeverity;
  components: LifecycleComponent[];
  informational: Array<{ id: string; label: string; version: string }>;
}

const SEV_RANK: Record<LifecycleSeverity, number> = { none: 0, watch: 1, warning: 2, critical: 3 };
const MEMO_TTL_MS = 6 * 60 * 60 * 1000;
let memo: { at: number; value: PlatformLifecycleResult } | null = null;

export function _resetLifecycleMemo(): void { memo = null; }

export async function getPlatformLifecycle(opts: { force?: boolean } = {}): Promise<PlatformLifecycleResult> {
  if (!opts.force && memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.value;
  const now = new Date();
  const base: PlatformLifecycleResult = {
    computedAt: now.toISOString(), datasetReviewedAt: null, datasetError: null,
    severity: "none", components: [], informational: [],
  };

  let dataset: PlatformEolDataset;
  try {
    dataset = loadPlatformEolDataset();
  } catch (err: any) {
    const value = { ...base, datasetError: err?.message ?? "dataset could not be read" };
    memo = { at: Date.now(), value };
    return value;
  }

  const observed = await observePlatformStack();
  const components: LifecycleComponent[] = [];
  for (const tech of dataset.technologies) {
    const obs = observed.find((o) => o.id === tech.id);
    if (!obs) continue;
    const grade = gradeComponent(tech, obs.observedVersion, now, { installed: obs.probeStatus !== "absent" });
    const targetRow = tech.charonTarget ? tech.tracks.find((t) => t.track === tech.charonTarget) : undefined;
    components.push({
      ...obs,
      label: tech.label,
      policy: "dated",
      polarisTarget: tech.charonTarget ?? null,
      targetTrackEolAt: targetRow?.eol ?? null,
      source: tech.source ?? null,
      playbook: null,
      grade,
    });
  }

  const agentVersion = getManifest()?.version;
  const value: PlatformLifecycleResult = {
    ...base,
    datasetReviewedAt: dataset.reviewedAt,
    severity: components.reduce<LifecycleSeverity>((w, c) => (SEV_RANK[c.grade.severity] > SEV_RANK[w] ? c.grade.severity : w), "none"),
    components,
    informational: [
      { id: "charon", label: "Charon", version: getAppVersion() },
      ...(agentVersion ? [{ id: "charon-agent", label: "Charon Agent (installers)", version: agentVersion }] : []),
    ],
  };
  memo = { at: Date.now(), value };
  return value;
}
