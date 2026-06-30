/**
 * src/services/nginxRenderer.ts — Render the nginx site from settings.
 *
 * Substitutes {{TOKENS}} in deploy/nginx/charon.conf.template from Server
 * Settings (server name, upstream ports, cert/key paths) and returns the
 * concrete config. nginxApplyService stages this, validates with `nginx -t`,
 * and reloads under sudo. Keeping rendering separate from applying means the UI
 * can show a diff/preview before touching the live config.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NginxSettings {
  serverName: string;
  webPort: number;
  endpointPort: number;
  certPath: string;
  keyPath: string;
}

const DEFAULTS: Omit<NginxSettings, "serverName" | "certPath" | "keyPath"> = {
  webPort: 3000,
  endpointPort: 3001,
};

function templatePath(): string {
  // Resolve relative to the project root (works from src/ and dist/).
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../../deploy/nginx/charon.conf.template", "../../../deploy/nginx/charon.conf.template"]) {
    const p = resolve(here, rel);
    try {
      readFileSync(p);
      return p;
    } catch {
      /* try next */
    }
  }
  throw new Error("charon.conf.template not found");
}

export function renderNginxConfig(settings: NginxSettings): string {
  const tmpl = readFileSync(templatePath(), "utf-8");
  const map: Record<string, string> = {
    SERVER_NAME: settings.serverName,
    WEB_PORT: String(settings.webPort || DEFAULTS.webPort),
    ENDPOINT_PORT: String(settings.endpointPort || DEFAULTS.endpointPort),
    CERT_PATH: settings.certPath,
    KEY_PATH: settings.keyPath,
  };
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_m, key) => map[key] ?? `{{${key}}}`);
}
