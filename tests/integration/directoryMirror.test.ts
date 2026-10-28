/**
 * tests/integration/directoryMirror.test.ts — persisting a discovery read into
 * the DirectoryObject mirror (discovery/directoryDiscovery → persistObjects).
 *
 * Real database (a *_test one; skips otherwise — see _helpers.ts). Pins:
 * chunked upserts are idempotent per (integration, kind, externalId), a re-read
 * UPDATES rows in place (a user's changed memberOf replaces the old one), and
 * the `device` kind persists.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { persistObjects } from "../../src/services/discovery/directoryDiscovery.js";
import type { DiscoveredDirectoryObject } from "../../src/services/directoryTypes.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

let integrationId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  const row = await prisma.integration.create({ data: { type: "activedirectory", name: "mirror-test-ad", config: {} } });
  integrationId = row.id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.integration.deleteMany({ where: { id: integrationId } });
});

dbDescribe("directory mirror persistence", () => {
  it("upserts across chunks, idempotently, and updates in place", async () => {
    const users: DiscoveredDirectoryObject[] = Array.from({ length: 1203 }, (_, i) => ({
      kind: "user",
      externalId: `guid-${i}`,
      name: `User ${i}`,
      identifier: `user${i}@corp.example`,
      attributes: { memberOf: ["CN=Staff,DC=corp,DC=example"] },
    }));
    const device: DiscoveredDirectoryObject = { kind: "device", externalId: "dev-1", name: "PC-1", identifier: "pc-1.corp.example", attributes: { disabled: false } };

    const first = await persistObjects(integrationId, [...users, device]);
    expect(first).toEqual({ user: 1203, group: 0, ou: 0, device: 1 });
    expect(await prisma.directoryObject.count({ where: { integrationId } })).toBe(1204);

    // Re-read: same ids, user 0's membership changed.
    users[0] = { ...users[0], attributes: { memberOf: ["CN=Finance,DC=corp,DC=example"] } };
    await persistObjects(integrationId, [...users, device]);
    expect(await prisma.directoryObject.count({ where: { integrationId } })).toBe(1204);
    const u0 = await prisma.directoryObject.findUnique({
      where: { integrationId_kind_externalId: { integrationId, kind: "user", externalId: "guid-0" } },
    });
    expect((u0!.attributes as any).memberOf).toEqual(["CN=Finance,DC=corp,DC=example"]);
    const d = await prisma.directoryObject.findFirst({ where: { integrationId, kind: "device" } });
    expect(d!.identifier).toBe("pc-1.corp.example");
  });
});
