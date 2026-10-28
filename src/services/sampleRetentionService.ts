/**
 * src/services/sampleRetentionService.ts — Retention tab ("Sample Retention" card).
 *
 * Ported from polaris (src/services/sampleRetentionService.ts), which keeps one
 * Setting("sampleRetention") row of per-entity retention windows: TIERED
 * entities (detail/hourly/daily rollups of device metric samples) and FLAT
 * entities (one window each). Encoding, verbatim: positive = keep N days,
 * 0 = OFF (prune everything), FOREVER (-1) = keep forever.
 *
 * Charon adaptation: Charon stores no tiered metric samples, so there are no
 * tiered entities. The flat entities are what Charon's retention prune
 * (src/jobs/retentionPrune.ts) actually deletes:
 *   events               — the audit log (Event rows). Default 90 days, seeded
 *                          from the pre-port Setting "retention.eventDays".
 *                          0 is refused: "delete the whole audit log every
 *                          prune" is never what an operator means.
 *   verificationSessions — VerificationSession rows, counted from when they
 *                          expired or were revoked. Default 1 day.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

export const SETTING_KEY = "sampleRetention";
/** Legacy key the pre-port retentionPrune read the audit-log window from. */
export const LEGACY_EVENT_DAYS_KEY = "retention.eventDays";
export const FOREVER = -1;
export const MAX_DAYS = 3650;

export type FlatRetentionEntity = "events" | "verificationSessions";
export const FLAT_RETENTION_ENTITIES: FlatRetentionEntity[] = ["events", "verificationSessions"];

export interface FlatRetention {
  days: number;
}

export type SampleRetention = Record<FlatRetentionEntity, FlatRetention>;

const DEFAULT_DAYS: Record<FlatRetentionEntity, number> = {
  events: 90,
  verificationSessions: 1,
};

/** Entities where 0 ("off — prune everything") is refused. */
const ZERO_REFUSED: ReadonlySet<FlatRetentionEntity> = new Set(["events"]);

export function defaultSampleRetention(): SampleRetention {
  return {
    events: { days: DEFAULT_DAYS.events },
    verificationSessions: { days: DEFAULT_DAYS.verificationSessions },
  };
}

/** Accept positive (N days, ≤ MAX_DAYS), 0, or FOREVER. Anything else → null. */
export function parseDays(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  if (v === FOREVER || v === 0) return v;
  if (v >= 1 && v <= MAX_DAYS) return v;
  return null;
}

/** Pure: stored row (+ legacy event-days) → fully-defaulted retention. */
export function parseSampleRetention(raw: unknown, legacyEventDays?: unknown): SampleRetention {
  const out = defaultSampleRetention();
  const legacy = (legacyEventDays as { days?: unknown } | null | undefined)?.days;
  const legacyDays = parseDays(legacy);
  if (legacyDays !== null && legacyDays !== 0) out.events.days = legacyDays;
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const e of FLAT_RETENTION_ENTITIES) {
    const days = parseDays((r[e] as { days?: unknown } | undefined)?.days);
    if (days !== null && !(days === 0 && ZERO_REFUSED.has(e))) out[e] = { days };
  }
  return out;
}

/**
 * Pure: merge an operator patch onto the current value. Unknown keys (e.g. a
 * polaris tiered entity) are ignored; a key present with an invalid value is
 * a 400 rather than a silent keep.
 */
export function mergeSampleRetention(current: SampleRetention, input: unknown): SampleRetention {
  const next: SampleRetention = {
    events: { ...current.events },
    verificationSessions: { ...current.verificationSessions },
  };
  if (!input || typeof input !== "object") return next;
  const i = input as Record<string, unknown>;
  for (const e of FLAT_RETENTION_ENTITIES) {
    if (i[e] == null) continue;
    const days = parseDays((i[e] as { days?: unknown }).days);
    if (days === null) throw new AppError(400, `${e}: retention must be −1 (forever), 0 (off), or 1–${MAX_DAYS} days`);
    if (days === 0 && ZERO_REFUSED.has(e)) throw new AppError(400, `${e}: 0 would delete the entire audit log on every prune — use −1 (forever) or a number of days`);
    next[e] = { days };
  }
  return next;
}

export async function getSampleRetention(): Promise<SampleRetention> {
  const [row, legacy] = await Promise.all([
    prisma.setting.findUnique({ where: { key: SETTING_KEY } }),
    prisma.setting.findUnique({ where: { key: LEGACY_EVENT_DAYS_KEY } }),
  ]);
  return parseSampleRetention(row?.value, legacy?.value);
}

export async function updateSampleRetention(input: unknown): Promise<SampleRetention> {
  const next = mergeSampleRetention(await getSampleRetention(), input);
  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: SETTING_KEY },
      update: { value: next as never },
      create: { key: SETTING_KEY, value: next as never },
    }),
    // Keep the legacy key in step so anything still reading it agrees.
    prisma.setting.upsert({
      where: { key: LEGACY_EVENT_DAYS_KEY },
      update: { value: { days: next.events.days } },
      create: { key: LEGACY_EVENT_DAYS_KEY, value: { days: next.events.days } },
    }),
  ]);
  return next;
}

/** Cutoff date for a retention window, or null when nothing should be pruned
 *  (FOREVER). 0 → now (everything eligible). */
export function retentionCutoff(days: number, now: Date = new Date()): Date | null {
  if (days === FOREVER) return null;
  return new Date(now.getTime() - Math.max(0, days) * 86_400_000);
}
