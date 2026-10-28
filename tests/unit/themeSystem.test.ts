// The polaris theme system is spread over three files that have to agree:
// app.js (THEMES / TRANSIT_THEMES / THEME_BAND_POS — the dial), theme-init.js
// (KNOWN — the pre-paint resolver) and styles.css (one token block per id,
// copied verbatim from polaris). None of them is typechecked, so this reads
// them as text.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pub = (p: string) => fileURLToPath(new URL(`../../public/${p}`, import.meta.url));
const appJs = readFileSync(pub("js/app.js"), "utf8");
const initJs = readFileSync(pub("js/theme-init.js"), "utf8");
const css = readFileSync(pub("css/styles.css"), "utf8");

function ids(block: RegExp, src: string): string[] {
  const m = src.match(block);
  if (!m) throw new Error(`block not found: ${block}`);
  return [...m[1].matchAll(/id:\s*"([a-z]+)"/g)].map((x) => x[1]);
}

const selectable = ids(/var THEMES = \[([\s\S]*?)\];/, appJs);
const transit = ids(/var TRANSIT_THEMES = \[([\s\S]*?)\];/, appJs);

describe("theme system (polaris port)", () => {
  it("app.js lists the polaris themes in day order", () => {
    expect(selectable).toEqual(["morning", "noon", "nightfall"]);
    expect(transit).toEqual(["afternoon"]);
  });

  it("theme-init.js KNOWN mirrors app.js THEMES (no transit ids)", () => {
    const m = initJs.match(/var KNOWN = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const known = [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    expect(known).toEqual(selectable);
  });

  it("theme-init.js and app.js share one storage key", () => {
    expect(initJs).toContain('"charon-theme"');
    expect(appJs).toContain('THEME_STORAGE_KEY = "charon-theme"');
  });

  it("every theme has a band position and a token block in styles.css", () => {
    for (const id of [...selectable, ...transit]) {
      expect(appJs).toMatch(new RegExp(`THEME_BAND_POS = \\{[^}]*\\b${id}:`));
      expect(css).toContain(`[data-theme="${id}"]`);
    }
  });

  it("no retired dark/light theme ids remain in the shell", () => {
    expect(appJs).not.toMatch(/data-theme",\s*"(dark|light)"/);
    expect(appJs).not.toContain("theme-toggle\"");
    expect(initJs).not.toMatch(/\|\|\s*"dark"/);
  });

  it("ships the band art", () => {
    expect(existsSync(pub("img/brand/time-strip-desktop.webp"))).toBe(true);
  });
});
