/**
 * The Users / My Account / login pages (polaris port): the polaris-port pages
 * load the polaris client layer in the order the modules need, nothing left
 * of polaris's tag scoping or its Azure-named SAML routes reaches the client,
 * the login page's landing guard keeps redirects same-origin, and the sidebar
 * shows Users for either key that opens the page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));
const read = (p: string) => readFileSync(join(PUBLIC, p), "utf-8");

function scriptOrder(html: string): string[] {
  return [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
}

describe("polaris-port page script order", () => {
  for (const page of ["users.html", "account.html"]) {
    it(`${page} loads settings-api.js instead of api.js, and settings-ui.js after app.js`, () => {
      const order = scriptOrder(read(page));
      expect(order).not.toContain("api.js");
      expect(order.indexOf("settings-api.js")).toBeLessThan(order.indexOf("app.js"));
      expect(order.indexOf("settings-ui.js")).toBeGreaterThan(order.indexOf("app.js"));
      expect(order.indexOf("password-self.js")).toBeGreaterThan(order.indexOf("settings-ui.js"));
      expect(order.indexOf("webauthn.js")).toBeLessThan(order.indexOf("passkeys-self.js"));
    });
  }

  it("users.html loads table-sf and row-menu before users.js", () => {
    const order = scriptOrder(read("users.html"));
    expect(order.indexOf("table-sf.js")).toBeLessThan(order.indexOf("users.js"));
    expect(order.indexOf("row-menu.js")).toBeLessThan(order.indexOf("users.js"));
  });
});

describe("no polaris-only surfaces left", () => {
  const usersJs = read("js/users.js");
  const settingsApi = read("js/settings-api.js");
  it("users.js has no region / tag scoping or grant review", () => {
    for (const s of ["regionTags", "otherTags", "regionPickerHtml", "collectOtherTags", "markReviewed", "grantReviewNeeded", "/auth/azure/"]) {
      expect(usersJs).not.toContain(s);
    }
  });
  it("settings-api.js calls Charon's SAML paths and the moved login-access / agent-mode routes", () => {
    expect(settingsApi).not.toContain("/auth/azure/");
    expect(settingsApi).not.toContain("/server-settings/auth-mode");
    expect(settingsApi).toContain('"/auth/login-access"');
    expect(settingsApi).toContain('"/auth/agent-mode"');
  });
  it("the old Server Settings → Authentication tab is gone", () => {
    expect(read("server-settings.html")).not.toContain('data-tab="auth"');
  });
});

describe("login landing guard", () => {
  // Run login.js's safeLoginTarget in isolation: the IIFE needs a DOM, so
  // evaluate just the function out of the source.
  const src = read("js/login.js");
  const fn = src.slice(src.indexOf("function safeLoginTarget"), src.indexOf("function takeLoginTarget"));
  const ctx = vm.createContext({ window: { location: { origin: "https://charon.example" } }, URL });
  vm.runInContext(fn, ctx);
  const safe = (v: unknown) => vm.runInContext(`safeLoginTarget(${JSON.stringify(v)})`, ctx);

  it("keeps same-origin paths and refuses everything else", () => {
    expect(safe("/endpoints.html?id=1#x")).toBe("/endpoints.html?id=1#x");
    expect(safe("//evil.example")).toBe("/");
    expect(safe("/\\evil.example")).toBe("/");
    expect(safe("/\t/evil.example")).toBe("/");
    expect(safe("https://evil.example/")).toBe("/");
    expect(safe("/login.html?x=1")).toBe("/");
    expect(safe(null)).toBe("/");
  });
});

describe("sidebar", () => {
  it("shows Users for users OR authentication read", () => {
    expect(read("js/app.js")).toContain('["/users.html", "Users", "users", ["users", "authentication"]]');
  });
});
