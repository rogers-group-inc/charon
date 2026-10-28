// Ported from polaris tests/unit/customMibLayout.test.ts (Server Settings → Credentials port).
// Server half only: the client half slices polaris public/js/assets.js (the
// asset Custom MIB tab), which Charon does not have.
/**
 * `sanitizeWidgetLayout` is what makes a stored layout safe to render for THIS
 * profile — a stale editor must not keep a deleted widget or carry in another
 * profile's, and an off-grid width or height must fall back rather than break
 * the grid.
 */

import { describe, it, expect } from "vitest";
import { sanitizeWidgetLayout } from "../../src/services/credentials/manufacturerProfileService.js";

describe("sanitizeWidgetLayout (server)", () => {
  const ids = new Set(["a", "b", "c"]);

  it("keeps a valid layout as is", () => {
    const layout = { version: 1, columns: [{ id: "c1", width: 6, widgets: [{ id: "a", height: 2 }, { id: "b", height: 1 }] }] };
    expect(sanitizeWidgetLayout(layout, ids)).toEqual(layout);
  });

  it("drops unknown and repeated widgets, then the columns they emptied", () => {
    const out = sanitizeWidgetLayout({ version: 1, columns: [
      { id: "c1", width: 3, widgets: [{ id: "gone", height: 1 }] },
      { id: "c2", width: 4, widgets: [{ id: "a", height: 1 }, { id: "a", height: 3 }, { id: "other-profile", height: 1 }] },
    ] }, ids);
    expect(out).toEqual({ version: 1, columns: [{ id: "c2", width: 4, widgets: [{ id: "a", height: 1 }] }] });
  });

  it("falls back on an off-grid width or height instead of failing", () => {
    const out = sanitizeWidgetLayout({ columns: [{ id: "c1", width: 7, widgets: [{ id: "a", height: 9 }] }] }, ids);
    expect(out).toEqual({ version: 1, columns: [{ id: "c1", width: 3, widgets: [{ id: "a", height: 1 }] }] });
  });

  it("is null for nothing usable, so the tab shows its default grid", () => {
    expect(sanitizeWidgetLayout(null, ids)).toBeNull();
    expect(sanitizeWidgetLayout({ columns: "x" }, ids)).toBeNull();
    expect(sanitizeWidgetLayout({ columns: [{ id: "c", width: 3, widgets: [{ id: "zzz", height: 1 }] }] }, ids)).toBeNull();
  });
});
