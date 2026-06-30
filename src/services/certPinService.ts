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

interface PinStore {
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
  if (!s.staged.includes(sha256hexLower)) s.staged.push(sha256hexLower);
  await write(s);
}

/** Promote a staged pin to canonical and retire the rest. */
export async function promoteStagedPin(sha256hexLower: string): Promise<void> {
  await write({ canonical: sha256hexLower, staged: [] });
}
