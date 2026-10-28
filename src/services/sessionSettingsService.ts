/**
 * src/services/sessionSettingsService.ts — operator session behaviour
 * (Users → Authentication → Settings → Session).
 *
 * One Setting row, `sessionConfig`:
 *   autoLogoutMinutes — idle timeout. 0 = off (the 8-hour cookie cap still
 *                       applies). Enforced server-side in app.ts against
 *                       `session.lastActivity`, and mirrored by the client.
 *   skipLoginPage     — send unauthenticated page loads straight to the SSO
 *                       provider instead of /login.html. Only meaningful (and
 *                       only accepted) while SAML or OIDC is enabled; the
 *                       login page stays reachable with ?local=1.
 *
 * Polaris stored these inside its SAML row; Charon keeps them separate so the
 * session policy does not depend on which provider is configured.
 */

import { createSettingStore } from "./settingsStore.js";

export const SESSION_SETTING_KEY = "sessionConfig";
export const AUTO_LOGOUT_MAX_MINUTES = 1440;

export interface SessionSettings {
  autoLogoutMinutes: number;
  skipLoginPage: boolean;
}

export function defaultSessionSettings(): SessionSettings {
  return { autoLogoutMinutes: 0, skipLoginPage: false };
}

export function clampAutoLogout(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(AUTO_LOGOUT_MAX_MINUTES, Math.max(0, Math.trunc(n)));
}

export function parseSessionSettings(raw: unknown): SessionSettings {
  const d = defaultSessionSettings();
  if (raw == null || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  return {
    autoLogoutMinutes: clampAutoLogout(r.autoLogoutMinutes, d.autoLogoutMinutes),
    skipLoginPage: typeof r.skipLoginPage === "boolean" ? r.skipLoginPage : d.skipLoginPage,
  };
}

const store = createSettingStore<SessionSettings>({ key: SESSION_SETTING_KEY, ttlMs: 10_000, parse: parseSessionSettings });

/** Never throws: a failed read answers the defaults (no idle timeout, no skip). */
export async function getSessionSettings(): Promise<SessionSettings> {
  try {
    return await store.get();
  } catch {
    return defaultSessionSettings();
  }
}

/** Cached view for the per-request idle check; null when the cache is cold. */
export function peekSessionSettings(): SessionSettings | null {
  return store.peek();
}

export async function saveSessionSettings(input: Partial<SessionSettings>): Promise<SessionSettings> {
  const cur = await getSessionSettings();
  return store.save({
    autoLogoutMinutes: input.autoLogoutMinutes === undefined ? cur.autoLogoutMinutes : clampAutoLogout(input.autoLogoutMinutes, cur.autoLogoutMinutes),
    skipLoginPage: typeof input.skipLoginPage === "boolean" ? input.skipLoginPage : cur.skipLoginPage,
  });
}

export function invalidateSessionSettingsCache(): void {
  store.invalidate();
}
