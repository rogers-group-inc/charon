// The agent window (agent/ui) carries copies of the server's theme files so it
// looks and themes like the server. A copy that drifts silently ships an agent
// with a different palette, so this fails until both sides match again
// (re-copy public/ → agent/ui and bump agent/VERSION).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const COPIES = [
  ["public/css/styles.css", "agent/ui/css/styles.css"],
  ["public/css/charon.css", "agent/ui/css/charon.css"],
  ["public/js/theme-init.js", "agent/ui/js/theme-init.js"],
];

describe("agent UI theme files mirror the server's", () => {
  for (const [server, agent] of COPIES) {
    it(`${agent} is identical to ${server}`, () => {
      expect(readFileSync(root(agent), "utf8")).toBe(readFileSync(root(server), "utf8"));
    });
  }

  it("the agent page loads theme-init.js first in <head>", () => {
    const html = readFileSync(root("agent/ui/index.html"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.indexOf('<script src="/js/theme-init.js"></script>')).toBeGreaterThan(-1);
    expect(head.indexOf('<script src="/js/theme-init.js"></script>')).toBeLessThan(head.indexOf("<link"));
  });
});
