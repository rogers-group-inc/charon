/**
 * src/services/integrationConfig.ts — Secret handling for Integration.config.
 *
 * Charon improves on polaris's plaintext-at-rest model: every secret field in
 * an integration's config JSON is stored as an AES-256-GCM envelope (see
 * utils/crypto.ts), masked when projected to the API, and preserved-on-unchanged
 * when the edit modal resubmits the mask sentinel.
 *
 *   writeConfig()  — encrypt incoming secrets; preserve stored ciphertext when
 *                    the caller resubmits the mask/empty (so editing a non-secret
 *                    field never wipes the token).
 *   readConfigMasked() — project for the API: replace each secret with the mask.
 *   decryptConfig()    — decrypt for actual use by the integration service.
 */

import { encryptSecret, decryptSecret, isEncryptedEnvelope, isMaskedValue, SECRET_MASK } from "../utils/crypto.js";

export type IntegrationType = "fortimanager" | "fortigate" | "activedirectory" | "entraid" | "intune";

// Which config fields are secrets, per integration type.
const SECRET_FIELDS: Record<IntegrationType, string[]> = {
  fortimanager: ["apiToken", "apiKey", "password"],
  fortigate: ["apiToken", "apiKey"],
  activedirectory: ["bindPassword"],
  entraid: ["clientSecret"],
  intune: ["clientSecret"],
};

function secretFieldsFor(type: string): string[] {
  return SECRET_FIELDS[type as IntegrationType] ?? [];
}

type Cfg = Record<string, unknown>;

/**
 * Produce the stored config: encrypt each incoming secret; when the incoming
 * value is the mask sentinel or empty, keep the previously-stored ciphertext.
 */
export function writeConfig(type: string, existing: Cfg | null, incoming: Cfg): Cfg {
  const merged: Cfg = { ...(existing ?? {}), ...incoming };
  for (const field of secretFieldsFor(type)) {
    const incomingVal = incoming[field];
    if (isMaskedValue(incomingVal)) {
      // Preserve the stored (already-encrypted) value.
      if (existing && existing[field] !== undefined) merged[field] = existing[field];
      else delete merged[field];
      continue;
    }
    if (typeof incomingVal === "string" && incomingVal.length > 0) {
      merged[field] = encryptSecret(incomingVal);
    }
  }
  return merged;
}

/** Project config for the API: every secret field becomes the mask sentinel. */
export function readConfigMasked(type: string, config: Cfg): Cfg {
  const out: Cfg = { ...config };
  for (const field of secretFieldsFor(type)) {
    if (typeof out[field] === "string" && (out[field] as string).length > 0) {
      out[field] = SECRET_MASK;
    }
  }
  return out;
}

/** Decrypt config for actual use by an integration service. */
export function decryptConfig(type: string, config: Cfg): Cfg {
  const out: Cfg = { ...config };
  for (const field of secretFieldsFor(type)) {
    const v = out[field];
    if (typeof v === "string" && isEncryptedEnvelope(v)) {
      out[field] = decryptSecret(v);
    }
  }
  return out;
}
