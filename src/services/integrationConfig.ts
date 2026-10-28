/**
 * src/services/integrationConfig.ts — Secret handling for Integration.config.
 *
 * Charon improves on polaris's at-rest model: every secret field in an
 * integration's config JSON is stored as an AES-256-GCM envelope (see
 * utils/crypto.ts; never polaris's secretBox, which falls back to plaintext
 * when its key is unset), masked when projected to the API, and
 * preserved-on-unchanged when the edit modal resubmits the mask sentinel.
 *
 *   writeConfig()  — encrypt incoming secrets; preserve stored ciphertext when
 *                    the caller resubmits the mask/empty (so editing a non-secret
 *                    field never wipes the token) — but ONLY while the secret's
 *                    destination is unchanged (utils/secretDestination.ts,
 *                    ported from polaris): changing the host, port, TLS mode or
 *                    FortiManager's direct-mode leg requires re-entering the
 *                    secret, so an edit can never redirect a stored token.
 *   readConfigMasked() — project for the API: replace each secret with the mask.
 *   decryptConfig()    — decrypt for actual use by the integration service.
 */

import { encryptSecret, decryptSecret, isEncryptedEnvelope, isMaskedValue, SECRET_MASK } from "../utils/crypto.js";
import { restoreStoredSecrets } from "../utils/secretDestination.js";

export type IntegrationType = "fortimanager" | "fortigate" | "activedirectory" | "entraid";

// Which config fields are secrets, per integration type.
export const SECRET_FIELDS: Record<IntegrationType, readonly string[]> = {
  fortimanager: ["apiToken", "fortigateApiToken"],
  fortigate: ["apiToken"],
  activedirectory: ["bindPassword"],
  entraid: ["clientSecret"],
};

export function secretFieldsFor(type: string): readonly string[] {
  return SECRET_FIELDS[type as IntegrationType] ?? [];
}

type Cfg = Record<string, unknown>;

/**
 * Produce the stored config: encrypt each incoming secret; when the incoming
 * value is the mask sentinel or empty, keep the previously-stored ciphertext —
 * unless the destination moved, which throws a 400 naming the field to re-enter.
 */
export function writeConfig(type: string, existing: Cfg | null, incoming: Cfg): Cfg {
  const merged: Cfg = { ...(existing ?? {}), ...incoming };
  const secrets = secretFieldsFor(type);
  // A blank / masked secret with a moved destination throws here.
  restoreStoredSecrets(merged, existing, secrets, incoming);
  for (const field of secrets) {
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
