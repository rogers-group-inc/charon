// public/js/brand-logo.js (ported from polaris) decides which mark a surface
// paints: a custom upload, else the shipped theme-paired art, else nothing and
// the name as text. It is a browser script, so this runs it in a vm sandbox.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));
const SRC = readFileSync(join(PUBLIC, "js", "brand-logo.js"), "utf8");

function load(theme = "nightfall") {
  const document = {
    currentScript: { getAttribute: () => "/js/brand-logo.js" },
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { getAttribute: () => theme },
    head: { appendChild: () => {} },
    addEventListener: () => {},
    createElement: () => ({}),
  };
  const win: Record<string, unknown> = { document };
  vm.runInNewContext(SRC, { window: win, document });
  return win.CharonBrandLogo as {
    ART: Record<string, Record<string, string>> | null;
    resolve: (b: unknown, surface: string) => { src: string | null; custom: boolean; showName: boolean; showSubtitle: boolean };
    customOn: (b: unknown, surface: string) => boolean;
  };
}

const UPLOAD = { appName: "Acme", subtitle: "ZTNA", customLogo: true, logoUrl: "/uploads/custom-logo.png", logoVersion: "abc" };

describe("brand-logo.js", () => {
  it("paints a custom upload, versioned, with the name beside it", () => {
    const r = load().resolve(UPLOAD, "sidebar");
    expect(r).toMatchObject({ src: "/uploads/custom-logo.png?v=abc", custom: true, showName: true, showSubtitle: true });
  });

  it("honours the per-surface flags", () => {
    const bl = load();
    expect(bl.customOn({ ...UPLOAD, logoOnSidebar: false }, "sidebar")).toBe(false);
    expect(bl.customOn({ ...UPLOAD, logoOnLogin: false }, "login")).toBe(false);
    expect(bl.customOn({ ...UPLOAD, logoOnLogin: false }, "sidebar")).toBe(true);
  });

  it("reads the pre-login payload (logoUrl only when there is one to show)", () => {
    const bl = load();
    expect(bl.resolve({ appName: "Acme", subtitle: "", logoUrl: "/uploads/custom-logo.webp", logoVersion: null }, "login").custom).toBe(true);
    expect(bl.resolve({ appName: "Acme", subtitle: "", logoUrl: null, logoVersion: null }, "login").src).toBeNull();
  });

  it("falls back to no mark and the name as text when there is no upload", () => {
    const bl = load();
    const r = bl.resolve({ appName: "Charon", subtitle: "", customLogo: false, logoUrl: "" }, "sidebar");
    if (bl.ART && bl.ART.sidebar) {
      expect(r.src).toContain(bl.ART.sidebar.dark);
      expect(r.showName).toBe(false);
    } else {
      expect(r).toMatchObject({ src: null, custom: false, showName: true });
    }
  });

  it("every art file ART names ships in public/", () => {
    const art = load().ART;
    for (const set of Object.values(art ?? {})) {
      for (const p of Object.values(set)) expect(existsSync(join(PUBLIC, p)), p).toBe(true);
    }
  });

  it("loads before app.js on every app page and before login.js on login", () => {
    for (const f of readdirSync(PUBLIC).filter((x) => x.endsWith(".html"))) {
      const html = readFileSync(join(PUBLIC, f), "utf8");
      for (const consumer of ['<script src="/js/app.js"></script>', '<script src="/js/login.js"></script>']) {
        if (!html.includes(consumer)) continue;
        const at = html.indexOf('<script src="/js/brand-logo.js"></script>');
        expect(at, f).toBeGreaterThan(-1);
        expect(at, f).toBeLessThan(html.indexOf(consumer));
      }
    }
  });
});
