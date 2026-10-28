/**
 * tests/unit/directoryDiscoverySweep.test.ts — the directory mirror's removal
 * guard (discovery/directoryDiscovery → planSweep).
 *
 * A deleted user must lose the tags their memberOf granted, so objects a run no
 * longer returns are removed — but a partial or empty read looks exactly like a
 * deleted directory, and a bad bind can return nothing at all. The guards keep a
 * bad read from wiping a fleet's tags.
 */

import { describe, it, expect } from "vitest";
import { planSweep, SWEEP_MIN_CAP } from "../../src/services/discovery/directoryDiscovery.js";

const ids = (n: number, prefix = "u") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("planSweep", () => {
  it("removes the ids a whole read no longer returned", () => {
    const plan = planSweep(["a", "b", "c"], new Set(["a", "c"]), true);
    expect(plan).toEqual({ remove: ["b"], refused: null });
  });

  it("refuses on a partial read (cancelled / capped / failed member read)", () => {
    const plan = planSweep(["a", "b"], new Set(["a"]), false);
    expect(plan.remove).toEqual([]);
    expect(plan.refused).toMatch(/partial/);
  });

  it("refuses an EMPTY read — a bind / permission / base-DN answer, not an emptied directory", () => {
    const plan = planSweep(ids(10), new Set(), true);
    expect(plan.remove).toEqual([]);
    expect(plan.refused).toMatch(/empty/);
  });

  it("allows small directories to lose up to the minimum cap in one run", () => {
    const stored = ids(60);
    const present = new Set(stored.slice(0, 10)); // 50 gone of 60
    expect(planSweep(stored, present, true).remove).toHaveLength(SWEEP_MIN_CAP);
  });

  it("refuses removing more than 20% of a large directory at once", () => {
    const stored = ids(2000);
    const present = new Set(stored.slice(0, 1500)); // 500 gone > 400 cap
    const plan = planSweep(stored, present, true);
    expect(plan.remove).toEqual([]);
    expect(plan.refused).toMatch(/safety cap/);
    // 400 gone is exactly at the cap → allowed.
    expect(planSweep(stored, new Set(stored.slice(0, 1600)), true).remove).toHaveLength(400);
  });

  it("is a no-op when nothing is stored", () => {
    expect(planSweep([], new Set(["a"]), true)).toEqual({ remove: [], refused: null });
  });
});
