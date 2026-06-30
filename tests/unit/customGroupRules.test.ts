import { describe, it, expect } from "vitest";
import { userMatchesRules } from "../../src/services/customGroupService.ts";

const user = (attrs: Record<string, unknown>) => ({ identifier: "u@x", name: "U", attributes: attrs });

describe("custom-group rule engine", () => {
  it("matches when all 'all' conditions hold", () => {
    const u = user({ department: "OT", mail: "u@x" });
    expect(userMatchesRules(u, { all: [{ attr: "department", op: "eq", value: "ot" }] })).toBe(true);
  });

  it("fails when an 'all' condition does not hold", () => {
    const u = user({ department: "IT" });
    expect(userMatchesRules(u, { all: [{ attr: "department", op: "eq", value: "OT" }] })).toBe(false);
  });

  it("'any' requires at least one match", () => {
    const u = user({ department: "Finance" });
    expect(userMatchesRules(u, { any: [{ attr: "department", op: "eq", value: "OT" }, { attr: "department", op: "eq", value: "Finance" }] })).toBe(true);
  });

  it("contains + in operators", () => {
    const u = user({ memberOf: ["CN=OT-Admins,OU=Groups", "CN=All"] });
    expect(userMatchesRules(u, { all: [{ attr: "memberOf", op: "contains", value: "ot-admins" }] })).toBe(true);
    expect(userMatchesRules(u, { all: [{ attr: "department", op: "in", value: ["a", "b"] }] })).toBe(false);
  });

  it("a ruleset with no conditions matches nobody by rule (explicit members only)", () => {
    expect(userMatchesRules(user({ department: "OT" }), {})).toBe(false);
  });
});
