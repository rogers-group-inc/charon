/**
 * tests/unit/fmgWorker.test.ts
 *
 * Coverage for the FmgWorker two-lane split:
 *
 *   - Proxy lane: strict FIFO concurrency=1. Honors FMG's hard limit that
 *     `/sys/proxy/json` calls drop past 1-2 parallel requests.
 *   - Native lane: unbounded. Native FMG endpoints (CMDB, dvmdb) hit FMG's
 *     own database and parallelize freely.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/metrics.js", () => ({
  setFmgWorkerQueueDepth: vi.fn(),
  setFmgWorkerInflight: vi.fn(),
  setFmgWorkerNativeInflight: vi.fn(),
}));

import { getFmgWorker, __resetFmgWorkersForTests } from "../../src/services/fmgWorker.js";

beforeEach(() => {
  __resetFmgWorkersForTests();
});

/** Build a controllable async task: returns the task fn + manual resolve/reject. */
function deferredTask<T = void>(): {
  task: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
  started: () => boolean;
} {
  let started = false;
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {
    task: () => { started = true; return promise; },
    resolve,
    reject,
    started: () => started,
  };
}

describe("FmgWorker — proxy lane", () => {
  it("serializes calls at concurrency=1 (FIFO)", async () => {
    const w = getFmgWorker("itg1");
    const a = deferredTask();
    const b = deferredTask();
    const c = deferredTask();

    const pa = w.submitProxy("a", a.task);
    const pb = w.submitProxy("b", b.task);
    const pc = w.submitProxy("c", c.task);

    // Microtask drain so the first entry starts.
    await new Promise((r) => setTimeout(r, 0));

    expect(a.started()).toBe(true);
    expect(b.started()).toBe(false);
    expect(c.started()).toBe(false);

    a.resolve(undefined);
    await pa;
    await new Promise((r) => setTimeout(r, 0));
    expect(b.started()).toBe(true);
    expect(c.started()).toBe(false);

    b.resolve(undefined);
    await pb;
    await new Promise((r) => setTimeout(r, 0));
    expect(c.started()).toBe(true);

    c.resolve(undefined);
    await pc;
  });

  it("rejects queued entries on abort without starting them", async () => {
    const w = getFmgWorker("itg2");
    const blocker = deferredTask();
    const ac = new AbortController();
    const skipped = deferredTask();

    const p1 = w.submitProxy("blocker", blocker.task);
    const p2 = w.submitProxy("skipped", skipped.task, ac.signal);

    await new Promise((r) => setTimeout(r, 0));
    expect(blocker.started()).toBe(true);

    ac.abort();
    await expect(p2).rejects.toThrow(/abort/i);
    expect(skipped.started()).toBe(false);

    blocker.resolve(undefined);
    await p1;
  });
});

describe("FmgWorker — native lane", () => {
  it("runs all submissions concurrently (no queue)", async () => {
    const w = getFmgWorker("itg3");
    const a = deferredTask();
    const b = deferredTask();
    const c = deferredTask();

    const pa = w.submitNative("a", a.task);
    const pb = w.submitNative("b", b.task);
    const pc = w.submitNative("c", c.task);

    await new Promise((r) => setTimeout(r, 0));
    // All three should have started simultaneously — no serial gating.
    expect(a.started()).toBe(true);
    expect(b.started()).toBe(true);
    expect(c.started()).toBe(true);
    expect(w.nativeInFlightCount).toBe(3);

    a.resolve(undefined); b.resolve(undefined); c.resolve(undefined);
    await Promise.all([pa, pb, pc]);
    expect(w.nativeInFlightCount).toBe(0);
  });

  it("decrements inflight even when the task throws", async () => {
    const w = getFmgWorker("itg4");
    await expect(w.submitNative("boom", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(w.nativeInFlightCount).toBe(0);
  });

  it("rejects with AbortError when signal is already aborted", async () => {
    const w = getFmgWorker("itg5");
    const ac = new AbortController();
    ac.abort();
    await expect(
      w.submitNative("x", async () => "should not run", ac.signal),
    ).rejects.toThrow(/abort/i);
    expect(w.nativeInFlightCount).toBe(0);
  });
});

describe("FmgWorker — proxy and native lanes do not block each other", () => {
  it("a blocked proxy task doesn't prevent native tasks from running", async () => {
    const w = getFmgWorker("itg6");
    const proxy = deferredTask();
    const native = deferredTask();

    const pProxy  = w.submitProxy("proxy", proxy.task);
    const pNative = w.submitNative("native", native.task);

    await new Promise((r) => setTimeout(r, 0));
    expect(proxy.started()).toBe(true);
    expect(native.started()).toBe(true);

    native.resolve(undefined);
    await pNative;
    expect(proxy.started()).toBe(true); // proxy still running

    proxy.resolve(undefined);
    await pProxy;
  });
});
