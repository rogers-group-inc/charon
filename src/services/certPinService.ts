/**
 * src/services/certPinService.ts — Server leaf-cert pins handed to agents.
 *
 * The agent trusts ONLY these SHA-256 leaf-cert fingerprints (not system
 * roots). Stored in Setting "agent.cert_pins" as { canonical, staged[] }:
 *   - canonical — the current leaf-cert pin agents enroll against.
 *   - staged[]  — new pin(s) staged BEFORE a cert rotation, so every agent is
 *                 told to accept old+new during the rollover; after the cert
 *                 rotates and all agents have heartbeated, the staged pin is
 *                 promoted to canonical and the old one retired.
 *
 * Milestone 7 (Certificates tab) computes the actual leaf SHA-256 from the
 * uploaded cert and calls setCanonicalPin(); this module is the shared store
 * and the dual-pin rotation API.
 */

import { prisma } from "../db.js";

const KEY = "agent.cert_pins";

export interface PinStore {
  canonical: string | null;
  staged: string[];
}

async function read(): Promise<PinStore> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const v = (row?.value as Partial<PinStore> | undefined) ?? {};
  return { canonical: v.canonical ?? null, staged: Array.isArray(v.staged) ? v.staged : [] };
}

async function write(store: PinStore): Promise<void> {
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: store as any },
    update: { value: store as any },
  });
  // Every pin change (stage / swap / retire / bootstrap) pushes refresh-config
  // to every connected agent so it re-reads GET /agents/config and picks the
  // new set up now, not on its next poll (rule 4a). Best-effort; never throws.
  await import("./agentChannelService.js")
    .then((m) => m.publishConfigRefresh("*"))
    .catch(() => {});
}

/** Pins an agent should trust: canonical first, then any staged. */
export async function getAgentCertPins(): Promise<string[]> {
  const s = await read();
  return [s.canonical, ...s.staged].filter((p): p is string => !!p);
}

export async function getPinStore(): Promise<PinStore> {
  return read();
}

/** Set the canonical pin (e.g. on first cert upload). Clears staged. */
export async function setCanonicalPin(sha256hexLower: string): Promise<void> {
  await write({ canonical: sha256hexLower, staged: [] });
}

/** Stage a new pin ahead of a cert rotation (agents start accepting old+new). */
export async function stageNewPin(sha256hexLower: string): Promise<void> {
  const s = await read();
  if (s.canonical === sha256hexLower || s.staged.includes(sha256hexLower)) return;
  s.staged.push(sha256hexLower);
  await write(s);
}

/** Promote a staged pin to canonical and retire the rest. */
export async function promoteStagedPin(sha256hexLower: string): Promise<void> {
  await write({ canonical: sha256hexLower, staged: [] });
}

// ─── Server Settings → Web Server: rotate-certificate support ────────────────
//
// Ported from polaris's per-agent dual-pin routes (/agents/cert-pins/*) onto
// charon's GLOBAL pin store: bulk-add = stage the new pin (every agent picks
// it up on its next /agents/config poll), the cert swap = make the new pin
// canonical while KEEPING the old one staged, bulk-remove = retire the old pin.
// The per-Endpoint serverCertFingerprint / additionalCertFingerprints columns
// record the pin set each agent was last HANDED (enrollment + /agents/config),
// which is what the uptake summary tallies.

/** Lowercase 64-hex SHA-256 from "sha256:<hex>", colon-separated, or bare hex; null if invalid. */
export function normalizePin(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.trim().replace(/^sha256:/i, "").replace(/:/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** Pure: the store after the served cert becomes `newPin` (old pins stay accepted). */
export function computeSwap(store: PinStore, newPin: string): PinStore {
  const keep = [store.canonical, ...store.staged].filter((p): p is string => !!p && p !== newPin);
  return { canonical: newPin, staged: Array.from(new Set(keep)) };
}

export type RetireOutcome = "retired" | "not_present" | "last_pin";

/**
 * Pure: the store after `pin` is retired. Retiring the canonical pin promotes
 * the first staged pin; retiring the LAST pin is refused (agents would lose
 * their only trust anchor).
 */
export function computeRetire(store: PinStore, pin: string): { outcome: RetireOutcome; store: PinStore } {
  const all = [store.canonical, ...store.staged].filter((p): p is string => !!p);
  if (!all.includes(pin)) return { outcome: "not_present", store };
  const remaining = all.filter((p) => p !== pin);
  if (remaining.length === 0) return { outcome: "last_pin", store };
  return { outcome: "retired", store: { canonical: remaining[0], staged: remaining.slice(1) } };
}

/** After a cert swap: new pin canonical, previous pins remain accepted until retired. */
export async function swapCanonicalPin(newPin: string): Promise<PinStore> {
  const next = computeSwap(await read(), newPin);
  await write(next);
  return next;
}

/**
 * Pure: a fresh install has no canonical pin until the first rotation. Adopt
 * the served (bootstrap) cert's pin as canonical so the first agents can
 * enroll and pin it. Returns null — change nothing — whenever a canonical pin
 * already exists: this never replaces an operator's pin (business rule 4a).
 */
export function computeBootstrap(store: PinStore, servedPin: string): PinStore | null {
  if (store.canonical) return null;
  return { canonical: servedPin, staged: store.staged.filter((p) => p !== servedPin) };
}

/** Apply computeBootstrap; the pin adopted, or null when nothing changed. */
export async function adoptBootstrapPin(servedPin: string): Promise<string | null> {
  const next = computeBootstrap(await read(), servedPin);
  if (!next) return null;
  await write(next);
  return servedPin;
}

export async function retirePin(pin: string): Promise<RetireOutcome> {
  const { outcome, store } = computeRetire(await read(), pin);
  if (outcome === "retired") await write(store);
  return outcome;
}

/** Record the pin set an agent was just handed (drives the uptake summary). */
export async function recordDeliveredPins(endpointId: string, pins: string[]): Promise<void> {
  const cur = await prisma.endpoint.findUnique({
    where: { id: endpointId },
    select: { serverCertFingerprint: true, additionalCertFingerprints: true },
  });
  if (!cur) return;
  const same =
    cur.serverCertFingerprint === (pins[0] ?? null) &&
    cur.additionalCertFingerprints.join(",") === pins.slice(1).join(",");
  if (same) return; // the common case — no write per config poll
  await prisma.endpoint.update({
    where: { id: endpointId },
    data: { serverCertFingerprint: pins[0] ?? null, additionalCertFingerprints: pins.slice(1) },
  });
}

export interface DeliveredPinRow {
  serverCertFingerprint: string | null;
  additionalCertFingerprints: string[];
}

/** Endpoints holding a live bearer (enrolled/online/offline) — polaris's installStatus "active". */
export async function listActiveDeliveredPins(): Promise<DeliveredPinRow[]> {
  return prisma.endpoint.findMany({
    where: { status: { in: ["enrolled", "online", "offline"] } },
    select: { serverCertFingerprint: true, additionalCertFingerprints: true },
  });
}

/** Pure: polaris's summary tally — per pin, how many agents hold it canonical vs staged. */
export function tallyPins(rows: DeliveredPinRow[]): Array<{ pin: string; canonical: number; staged: number }> {
  const tally = new Map<string, { canonical: number; staged: number }>();
  const bump = (pin: string, field: "canonical" | "staged") => {
    const k = pin.toLowerCase();
    const e = tally.get(k) ?? { canonical: 0, staged: 0 };
    e[field] += 1;
    tally.set(k, e);
  };
  for (const r of rows) {
    if (r.serverCertFingerprint) bump(r.serverCertFingerprint, "canonical");
    for (const p of r.additionalCertFingerprints) bump(p, "staged");
  }
  return Array.from(tally.entries()).map(([pin, c]) => ({ pin, ...c }));
}

export function rowHasPin(r: DeliveredPinRow, pin: string): boolean {
  return [r.serverCertFingerprint, ...r.additionalCertFingerprints].some((p) => !!p && p.toLowerCase() === pin);
}
