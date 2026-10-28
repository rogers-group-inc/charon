/**
 * src/utils/secretMask.ts — the mask sentinel shared with the
 * Credentials tab (public/js/server-settings-credentials.js `_credMask`).
 * Ported from polaris utils/secretMask.ts; the sentinel is Charon's own
 * SECRET_MASK (utils/crypto.ts), which is the same eight bullets.
 */

import { SECRET_MASK } from "./crypto.js";

export { SECRET_MASK };

/** A string made only of mask bullets (any count) — never a real secret. */
export function isMaskedSecret(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && /^•+$/.test(value);
}
