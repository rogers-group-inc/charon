/**
 * tests/unit/fortinetEnforcement.test.ts — fortinetEnforcementService on the
 * ported (paced) FortiGate client.
 *
 *   - dry-run writes NOTHING to a firewall (rule 2) but records the state;
 *   - FortiManager enforce stays dry-run (half-applied policy package risk);
 *   - enforce touches only charon-* objects (rule 1);
 *   - a group read that fails for any reason OTHER than 404 must not be read
 *     as "group missing" — that would POST a duplicate (or worse, a 401 pause
 *     would turn into a create attempt).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../../src/utils/errors.js";

const h = vi.hoisted(() => {
  const state: { integrations: any[]; endpoint: any } = { integrations: [], endpoint: null };
  return {
    state,
    fgGet: vi.fn(),
    fgWrite: vi.fn(async () => ({})),
    prisma: {
      endpoint: { findUnique: vi.fn(async () => state.endpoint) },
      integration: {
        findMany: vi.fn(async () => state.integrations),
        update: vi.fn(async () => ({})),
      },
      enforcementState: { upsert: vi.fn(async () => ({})) },
    },
  };
});

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/fortigateService.js", () => ({ fgGet: h.fgGet, fgWrite: h.fgWrite }));
vi.mock("../../src/services/eventService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/integrationConfig.js", () => ({ decryptConfig: (_t: string, c: unknown) => c }));

import { applyEndpointDelta, addrGroupName, endpointAddressName } from "../../src/services/fortinetEnforcementService.js";

const EP = { id: "0123456789abcdef-ep", currentIp: "10.1.2.3" };

beforeEach(() => {
  vi.clearAllMocks();
  h.state.endpoint = EP;
  h.state.integrations = [];
});

describe("fortinetEnforcementService", () => {
  it("names only charon-* objects", () => {
    expect(addrGroupName("finance")).toBe("charon-finance");
    expect(endpointAddressName(EP.id)).toBe("charon-ep-0123456789ab");
  });

  it("dry-run records intent and writes nothing to the firewall", async () => {
    h.state.integrations = [{ id: "i1", type: "fortigate", enforcementMode: "dry_run", config: {} }];
    await applyEndpointDelta(EP.id, ["finance"], []);
    expect(h.fgWrite).not.toHaveBeenCalled();
    expect(h.fgGet).not.toHaveBeenCalled();
    expect(h.prisma.enforcementState.upsert).toHaveBeenCalled();
  });

  it("FortiManager enforce stays dry-run", async () => {
    h.state.integrations = [{ id: "i1", type: "fortimanager", enforcementMode: "enforce", config: {} }];
    await applyEndpointDelta(EP.id, ["finance"], []);
    expect(h.fgWrite).not.toHaveBeenCalled();
  });

  it("enforce creates the group when the read 404s", async () => {
    h.state.integrations = [{ id: "i1", type: "fortigate", enforcementMode: "enforce", config: { host: "fw" } }];
    h.fgGet.mockRejectedValueOnce(new AppError(404, "Endpoint not found"));
    await applyEndpointDelta(EP.id, ["finance"], []);
    const paths = h.fgWrite.mock.calls.map((c: any[]) => `${c[1]} ${c[2]}`);
    expect(paths).toContain("POST /api/v2/cmdb/firewall/addrgrp");
    for (const call of h.fgWrite.mock.calls as any[][]) {
      const body = call[3] as { name?: string } | undefined;
      if (body?.name) expect(body.name.startsWith("charon-")).toBe(true);
    }
  });

  it("enforce updates the group's members when it exists", async () => {
    h.state.integrations = [{ id: "i1", type: "fortigate", enforcementMode: "enforce", config: { host: "fw" } }];
    h.fgGet.mockResolvedValueOnce([{ member: [{ name: "charon-ep-other" }] }]);
    await applyEndpointDelta(EP.id, ["finance"], []);
    const put = (h.fgWrite.mock.calls as any[][]).find((c) => c[1] === "PUT" && String(c[2]).includes("addrgrp"));
    expect(put).toBeDefined();
    expect((put![3] as any).member.map((m: any) => m.name).sort()).toEqual(["charon-ep-0123456789ab", "charon-ep-other"]);
  });

  it("a non-404 read failure never POSTs a duplicate group", async () => {
    h.state.integrations = [{ id: "i1", type: "fortigate", enforcementMode: "enforce", config: { host: "fw" } }];
    h.fgGet.mockRejectedValueOnce(new AppError(502, "Authentication failed (HTTP 401) for fw:443 — Charon has paused requests"));
    await applyEndpointDelta(EP.id, ["finance"], []);
    const groupPosts = (h.fgWrite.mock.calls as any[][]).filter((c) => c[1] === "POST" && c[2] === "/api/v2/cmdb/firewall/addrgrp");
    expect(groupPosts).toHaveLength(0);
    // The failure is recorded on the state rows, not swallowed.
    const statuses = (h.prisma.enforcementState.upsert.mock.calls as any[][]).map((c) => c[0].update?.status);
    expect(statuses).toContain("error");
  });
});
