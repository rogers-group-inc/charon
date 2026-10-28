/**
 * src/services/nginxRenderer.ts — Render the nginx site from settings.
 *
 * Substitutes {{TOKENS}} in deploy/nginx/charon.conf.template from Server
 * Settings (server name, upstream ports, cert/key paths, and the operator's
 * nginx Proxy controls — proxyConfigService) and returns the concrete config.
 * nginxApplyService stages this, validates with `nginx -t`, and reloads under
 * sudo. Keeping rendering separate from applying means the UI can show a
 * diff/preview before touching the live config.
 *
 * Every proxy-control token renders to ONE line (a directive, or a comment
 * when the control is off) so deploy/install-rhel.sh can render the same
 * template with plain `sed` defaults. Ported from polaris's renderer
 * (togglable directives are whole-line replacements, never half-commented;
 * output is LF-only and deterministic so its sha256 can detect drift).
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProxyConfig, type ProxyConfig } from "./proxyConfigService.js";

export interface NginxSettings {
  serverName: string;
  webPort: number;
  endpointPort: number;
  certPath: string;
  keyPath: string;
  /** Operator nginx controls; defaults (= the shipped template) when absent. */
  proxy?: ProxyConfig;
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

// The token values land unquoted in nginx directives — refuse anything that
// could smuggle a `;` / newline / brace in (defense in depth behind the Zod +
// proxyConfigService validation).
function assertSafeToken(name: string, v: string): string {
  if (/[;\r\n{}]/.test(v)) throw new Error(`Refusing to render nginx config: unsafe ${name}`);
  return v;
}

export function renderSslProtocols(cfg: ProxyConfig): string {
  for (const proto of cfg.tlsProtocols as unknown[]) {
    if (proto !== "TLSv1.2" && proto !== "TLSv1.3") {
      throw new Error("Refusing to render nginx config: tlsProtocols contains an unsupported value");
    }
  }
  return cfg.tlsProtocols.join(" ");
}

export function renderQuicListen(cfg: ProxyConfig): string {
  return cfg.http3Enabled
    ? `listen ${cfg.httpsPort} quic reuseport;      # HTTP/3`
    : "# HTTP/3 (QUIC) disabled in Server Settings";
}

export function renderAltSvcHeader(cfg: ProxyConfig): string {
  return cfg.http3Enabled
    ? `add_header Alt-Svc 'h3=":${cfg.httpsPort}"; ma=86400' always;   # advertise HTTP/3`
    : "# Alt-Svc not advertised (HTTP/3 disabled)";
}

export function renderHstsHeader(cfg: ProxyConfig): string {
  if (!cfg.hsts.enabled) return "# HSTS disabled in Server Settings";
  const d = [`max-age=${Math.floor(cfg.hsts.maxAgeSeconds)}`];
  if (cfg.hsts.includeSubDomains) d.push("includeSubDomains");
  if (cfg.hsts.preload) d.push("preload");
  // helmet also emits HSTS; hide the upstream copy so the client sees exactly
  // one header (RFC 6797 §8.1 — a UA honours only the first).
  return `add_header Strict-Transport-Security "${d.join("; ")}" always; proxy_hide_header Strict-Transport-Security;`;
}

export function renderMetricsAllow(cfg: ProxyConfig): string {
  const parts = cfg.prometheusAllowIps.map((ip) => `allow ${assertSafeToken("prometheus IP", ip)};`);
  parts.push("deny all;");
  return parts.join(" ");
}

export function renderNginxConfig(settings: NginxSettings, templateOverride?: string): string {
  const tmpl = (templateOverride ?? readFileSync(templatePath(), "utf-8")).replace(/\r\n/g, "\n");
  const proxy = settings.proxy ?? defaultProxyConfig();
  const map: Record<string, string> = {
    SERVER_NAME: assertSafeToken("server name", settings.serverName),
    WEB_PORT: String(settings.webPort || DEFAULTS.webPort),
    ENDPOINT_PORT: String(settings.endpointPort || DEFAULTS.endpointPort),
    CERT_PATH: assertSafeToken("cert path", settings.certPath),
    KEY_PATH: assertSafeToken("key path", settings.keyPath),
    HTTPS_PORT: String(proxy.httpsPort),
    QUIC_LISTEN: renderQuicListen(proxy),
    SSL_PROTOCOLS_LIST: renderSslProtocols(proxy),
    HSTS_HEADER: renderHstsHeader(proxy),
    ALT_SVC_HEADER: renderAltSvcHeader(proxy),
    METRICS_ALLOW: renderMetricsAllow(proxy),
  };
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_m, key) => map[key] ?? `{{${key}}}`);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
