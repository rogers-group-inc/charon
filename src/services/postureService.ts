/**
 * src/services/postureService.ts — Evaluate device posture → PostureState.
 *
 * The agent reports a raw posture blob (OS/patch level, disk encryption, AV/EDR,
 * firewall state, …). This module applies the operator-configured posture
 * policy (Setting "posture.policy") to derive compliant | noncompliant |
 * unknown. The derived state is a tag source (posture=compliant, etc.) so it
 * flows straight into the reconciler.
 */

import { prisma } from "../db.js";

export type PostureState = "unknown" | "compliant" | "noncompliant";

export interface PostureRaw {
  diskEncryption?: boolean;
  firewall?: boolean;
  antivirus?: boolean;
  osVersion?: string;
  patchAgeDays?: number;
  [k: string]: unknown;
}

export interface PosturePolicy {
  requireDiskEncryption: boolean;
  requireFirewall: boolean;
  requireAntivirus: boolean;
  maxPatchAgeDays: number | null;
}

const DEFAULT_POLICY: PosturePolicy = {
  requireDiskEncryption: true,
  requireFirewall: true,
  requireAntivirus: true,
  maxPatchAgeDays: null,
};

export async function getPosturePolicy(): Promise<PosturePolicy> {
  const row = await prisma.setting.findUnique({ where: { key: "posture.policy" } });
  return { ...DEFAULT_POLICY, ...((row?.value as Partial<PosturePolicy>) ?? {}) };
}

export async function setPosturePolicy(policy: Partial<PosturePolicy>): Promise<PosturePolicy> {
  const merged = { ...DEFAULT_POLICY, ...policy };
  await prisma.setting.upsert({
    where: { key: "posture.policy" },
    create: { key: "posture.policy", value: merged as any },
    update: { value: merged as any },
  });
  return merged;
}

/** Pure evaluation of a raw posture blob against a policy. */
export function evaluatePosture(raw: PostureRaw | null | undefined, policy: PosturePolicy): PostureState {
  if (!raw || Object.keys(raw).length === 0) return "unknown";
  if (policy.requireDiskEncryption && raw.diskEncryption !== true) return "noncompliant";
  if (policy.requireFirewall && raw.firewall !== true) return "noncompliant";
  if (policy.requireAntivirus && raw.antivirus !== true) return "noncompliant";
  if (policy.maxPatchAgeDays != null && typeof raw.patchAgeDays === "number" && raw.patchAgeDays > policy.maxPatchAgeDays) {
    return "noncompliant";
  }
  return "compliant";
}

/**
 * Apply a freshly-reported posture blob to an endpoint: store it, recompute the
 * state, and (when the state changed) return true so the caller can trigger a
 * tag reconcile.
 */
export async function ingestPosture(endpointId: string, raw: PostureRaw): Promise<{ state: PostureState; changed: boolean }> {
  const policy = await getPosturePolicy();
  const state = evaluatePosture(raw, policy);
  const existing = await prisma.endpoint.findUnique({ where: { id: endpointId }, select: { postureState: true } });
  const changed = existing?.postureState !== state;
  await prisma.endpoint.update({
    where: { id: endpointId },
    data: { posture: raw as any, postureState: state, postureAt: new Date() },
  });
  return { state, changed };
}
