import { describe, it, expect, afterEach } from "vitest";
import { roleConfig, getRole, isMigrateOnly, __resetRoleForTests } from "../../src/utils/role.ts";

afterEach(() => {
  delete process.env.CHARON_ROLE;
  __resetRoleForTests();
});

describe("role config", () => {
  it("defaults to 'all' (every capability) when CHARON_ROLE is unset", () => {
    __resetRoleForTests();
    const cfg = roleConfig(getRole());
    expect(cfg.role).toBe("all");
    expect(cfg.runsHttp && cfg.runsAgentComms && cfg.runsEnforcement && cfg.runsWorkers && cfg.runsSchedulers).toBe(true);
  });

  it("web runs http + schedulers + migrations but not enforcement/workers", () => {
    const cfg = roleConfig("web");
    expect(cfg.runsHttp).toBe(true);
    expect(cfg.runsSchedulers).toBe(true);
    expect(cfg.runsMigrations).toBe(true);
    expect(cfg.runsEnforcement).toBe(false);
    expect(cfg.runsWorkers).toBe(false);
  });

  it("endpoint runs agent comms only (no schedulers/enforcement)", () => {
    const cfg = roleConfig("endpoint");
    expect(cfg.runsAgentComms).toBe(true);
    expect(cfg.runsHttp).toBe(false);
    expect(cfg.runsSchedulers).toBe(false);
  });

  it("enforcer runs enforcement only", () => {
    const cfg = roleConfig("enforcer");
    expect(cfg.runsEnforcement).toBe(true);
    expect(cfg.runsHttp).toBe(false);
    expect(cfg.runsWorkers).toBe(false);
  });

  it("worker runs workers only", () => {
    const cfg = roleConfig("worker");
    expect(cfg.runsWorkers).toBe(true);
    expect(cfg.runsEnforcement).toBe(false);
  });

  it("migrate is one-shot and runs migrations", () => {
    expect(isMigrateOnly("migrate")).toBe(true);
    expect(roleConfig("migrate").runsMigrations).toBe(true);
  });

  it("falls back to 'all' on an unknown role", () => {
    process.env.CHARON_ROLE = "bogus";
    __resetRoleForTests();
    expect(getRole()).toBe("all");
  });
});
