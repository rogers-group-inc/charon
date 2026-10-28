/**
 * src/utils/settingSecret.ts — a secret field inside a JSON Setting row (the
 * OIDC client secret, the LDAP bind password).
 *
 *   - At rest it is a crypto.ts envelope (rule 3); `openSettingSecret()` also
 *     reads a legacy plaintext value so a row written before sealing still works.
 *   - On the way out it is SECRET_MASK (or "" when unset) — a GET never returns it.
 *   - On the way in, the echoed mask means "keep the stored one", anything else
 *     is the new value (blank clears it).
 *   - A kept secret never follows a changed DESTINATION: when the field that
 *     says where the secret is sent (an LDAP URL, an OIDC discovery URL / client
 *     id) changes in the same save, the mask is refused and the operator must
 *     type the secret again. Otherwise an operator with write access to the
 *     settings could point the stored secret at a server they control and
 *     read it off the wire.
 */

import { AppError } from "./errors.js";
import { decryptSecret, encryptSecret, isEncryptedEnvelope, SECRET_MASK } from "./crypto.js";

export function sealSettingSecret(plaintext: string): string {
  return plaintext ? encryptSecret(plaintext) : "";
}

export function openSettingSecret(stored: string | undefined | null): string {
  if (!stored) return "";
  return isEncryptedEnvelope(stored) ? decryptSecret(stored) : stored;
}

export function maskSettingSecret(stored: string | undefined | null): string {
  return stored ? SECRET_MASK : "";
}

/**
 * The stored value to keep after a save. `incoming` is what the client sent
 * (undefined = field omitted, keep); `destinations` pairs each destination
 * field's current value with the incoming one (undefined = unchanged).
 * Returns the SEALED value to store.
 */
export function nextSettingSecret(
  currentSealed: string,
  incoming: unknown,
  destinations: Array<{ label: string; current: string; incoming: string | undefined }>,
  secretLabel: string,
): string {
  if (incoming === undefined) return currentSealed;
  if (incoming !== SECRET_MASK) return sealSettingSecret(String(incoming ?? "").trim());
  if (!currentSealed) return "";
  const moved = destinations.find((d) => d.incoming !== undefined && d.incoming.trim() !== d.current.trim());
  if (moved) {
    throw new AppError(
      400,
      `The ${moved.label} changed, so the stored ${secretLabel} is not reused: a saved secret is never sent to a new destination. Enter the ${secretLabel} again to save this change.`,
    );
  }
  return currentSealed;
}
