/**
 * src/services/passwordPolicyService.ts — the DB side of the password
 * complexity policy (Users → Authentication → Settings). Ported from polaris.
 *
 * Single Setting row (`passwordPolicyConfig`), TTL-cached via settingsStore.
 * The rules themselves are pure and live in utils/passwordPolicy.ts.
 *
 * FAILS TO THE DEFAULT, NEVER TO "NO POLICY". Every read that throws resolves
 * to `defaultPasswordPolicy()` — the alternative reading of a failed read is
 * "accept any password", and a settings outage must not quietly lower the bar.
 * (The opposite posture to the Local Login Access gate's fail-OPEN: there,
 * failing safe means letting people in; here, keeping the bar up.)
 *
 * assertPasswordMeetsPolicy() is called by every route that stores a new
 * password: users.ts (admin create / reset), auth.ts (self-service change,
 * forced change at login) and setup/setupRoutes.ts (the first admin).
 */

import { createSettingStore } from "./settingsStore.js";
import { AppError } from "../utils/errors.js";
import {
  clampMinLength,
  defaultPasswordPolicy,
  parsePasswordPolicy,
  passwordPolicyError,
  type PasswordPolicy,
} from "../utils/passwordPolicy.js";

export const PASSWORD_POLICY_SETTING_KEY = "passwordPolicyConfig";

const passwordPolicyStore = createSettingStore<PasswordPolicy>({
  key: PASSWORD_POLICY_SETTING_KEY,
  ttlMs: 10_000,
  parse: parsePasswordPolicy,
});

export function invalidatePasswordPolicyCache(): void {
  passwordPolicyStore.invalidate();
}

/** The active policy. Never throws — a failed read resolves to the defaults. */
export async function getPasswordPolicy(): Promise<PasswordPolicy> {
  try {
    return await passwordPolicyStore.get();
  } catch {
    return defaultPasswordPolicy();
  }
}

export async function savePasswordPolicy(input: Partial<PasswordPolicy>): Promise<PasswordPolicy> {
  const current = await getPasswordPolicy();
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return passwordPolicyStore.save({
    minLength: input.minLength === undefined ? current.minLength : clampMinLength(input.minLength, current.minLength),
    requireLowercase: bool(input.requireLowercase, current.requireLowercase),
    requireUppercase: bool(input.requireUppercase, current.requireUppercase),
    requireNumber: bool(input.requireNumber, current.requireNumber),
    requireSpecial: bool(input.requireSpecial, current.requireSpecial),
    forceChangeOnLogin: bool(input.forceChangeOnLogin, current.forceChangeOnLogin),
  });
}

/** Throw a 400 AppError naming every unmet rule, or return cleanly. */
export async function assertPasswordMeetsPolicy(plaintext: string): Promise<void> {
  const message = passwordPolicyError(plaintext, await getPasswordPolicy());
  if (message) throw new AppError(400, message);
}

/**
 * Does this plaintext fail a policy that forces a change at login? Decides, at
 * local login, whether the session is issued or a forced change is demanded.
 * Never throws.
 */
export async function passwordNeedsPolicyChange(plaintext: string): Promise<boolean> {
  const policy = await getPasswordPolicy();
  if (!policy.forceChangeOnLogin) return false;
  return passwordPolicyError(plaintext, policy) !== null;
}
