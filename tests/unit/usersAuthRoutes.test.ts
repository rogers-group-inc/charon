/**
 * Route-level checks for the users + auth port: the two-step local login
 * (pending state held in the session, never a session id the client can
 * reuse), TOTP replay, the forced password change, and the users route's
 * escalation guards. Prisma is mocked; express-session uses its memory store.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import express from "express";
import session from "express-session";
import request from "supertest";

const { prisma } = vi.hoisted(() => ({ prisma: {} as Record<string, any> }));
vi.mock("../../src/db.ts", () => ({ prisma }));
vi.mock("../../src/db.js", () => ({ prisma }));
vi.mock("../../src/services/eventService.ts", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/eventService.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/webAccessSettingsService.js", () => ({ isLoginSourceAllowed: vi.fn().mockResolvedValue(true) }));

import { TOTP, Secret } from "otpauth";
import authRouter from "../../src/api/routes/auth.ts";
import usersRouter from "../../src/api/routes/users.ts";
import { errorHandler } from "../../src/api/middleware/errorHandler.ts";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.ts";
import { hashPassword } from "../../src/utils/password.ts";
import { encryptSecret } from "../../src/utils/crypto.ts";
import { clearLockout } from "../../src/utils/loginLockout.ts";
import { invalidatePasswordPolicyCache } from "../../src/services/passwordPolicyService.ts";

const all = (level: string) => Object.fromEntries(FUNCTION_KEYS.map((f) => [f.key, level]));
const ADMIN_ROLE = { id: "r-admin", name: "Administrator", isProtected: true, permissions: all("fullwrite"), updatedAt: new Date(), color: null };
const OP_ROLE = { id: "r-op", name: "Operator", isProtected: false, permissions: { ...all("write"), roles: "none" }, updatedAt: new Date(), color: null };

function app(preSession?: (req: express.Request) => void) {
  const a = express();
  a.use(express.json());
  a.use(session({ secret: "test", resave: false, saveUninitialized: false }));
  if (preSession) a.use((req, _res, next) => { preSession(req); next(); });
  a.use("/auth", authRouter);
  a.use("/users", usersRouter);
  a.use(errorHandler);
  return a;
}

const TOTP_SECRET = new Secret({ size: 20 }).base32;
let user: Record<string, any>;

beforeAll(async () => {
  process.env.CHARON_DATA_KEY = Buffer.alloc(32, 9).toString("base64");
});

beforeEach(async () => {
  for (const k of Object.keys(prisma)) delete prisma[k];
  clearLockout("alice");
  invalidatePasswordPolicyCache();
  user = {
    id: "u-alice",
    username: "alice",
    authProvider: "local",
    passwordHash: await hashPassword("Correct1!"),
    roleId: OP_ROLE.id,
    role: OP_ROLE,
    displayName: null,
    totpEnabledAt: null,
    totpSecret: null,
    totpBackupCodes: [],
    totpLastStep: null,
    lastLogin: null,
  };
  prisma.user = {
    findUnique: vi.fn(async () => ({ ...user })),
    update: vi.fn(async ({ data }: any) => Object.assign(user, data)),
    updateMany: vi.fn(async ({ data, where }: any) => {
      const last = user.totpLastStep;
      if (last !== null && last >= data.totpLastStep) return { count: 0 };
      void where;
      user.totpLastStep = data.totpLastStep;
      return { count: 1 };
    }),
  };
  prisma.setting = { findUnique: vi.fn().mockResolvedValue(null) };
  prisma.role = { findUnique: vi.fn(async () => OP_ROLE) };
});

describe("local login", () => {
  it("issues a session for a password-only account", async () => {
    const agent = request.agent(app());
    const res = await agent.post("/auth/login").send({ username: "alice", password: "Correct1!" });
    expect(res.body).toMatchObject({ ok: true, username: "alice", role: "Operator" });
    const me = await agent.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("alice");
  });

  it("refuses a wrong password with the generic message", async () => {
    const res = await request(app()).post("/auth/login").send({ username: "alice", password: "nope" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid username or password");
  });

  it("holds a TOTP account at the second step, then refuses the same code twice", async () => {
    user.totpEnabledAt = new Date();
    user.totpSecret = encryptSecret(TOTP_SECRET);
    const agent = request.agent(app());

    const step1 = await agent.post("/auth/login").send({ username: "alice", password: "Correct1!" });
    expect(step1.body).toEqual({ mfaRequired: true, methods: { totp: true, passkey: false } });
    expect((await agent.get("/auth/me")).status).toBe(401); // not signed in yet

    const code = new TOTP({ secret: Secret.fromBase32(TOTP_SECRET) }).generate();
    const step2 = await agent.post("/auth/login/totp").send({ code });
    expect(step2.body).toMatchObject({ ok: true, username: "alice" });

    // Same code, fresh login: the step was claimed.
    const again = request.agent(app());
    await again.post("/auth/login").send({ username: "alice", password: "Correct1!" });
    const replay = await again.post("/auth/login/totp").send({ code });
    expect(replay.status).toBe(401);
  });

  it("a TOTP step without a pending password step is refused", async () => {
    const res = await request(app()).post("/auth/login/totp").send({ code: "123456" });
    expect(res.status).toBe(401);
  });

  it("forces a password change when the policy demands it, then signs in", async () => {
    prisma.setting.findUnique = vi.fn().mockResolvedValue({ value: { minLength: 14, forceChangeOnLogin: true } });
    const agent = request.agent(app());
    const step1 = await agent.post("/auth/login").send({ username: "alice", password: "Correct1!" });
    expect(step1.body.passwordChangeRequired).toBe(true);
    expect((await agent.get("/auth/me")).status).toBe(401);

    const weak = await agent.post("/auth/login/password-change").send({ newPassword: "Short1!" });
    expect(weak.status).toBe(400);
    const ok = await agent.post("/auth/login/password-change").send({ newPassword: "MuchLonger1!pass" });
    expect(ok.body).toMatchObject({ ok: true, username: "alice" });
    expect((await agent.get("/auth/me")).status).toBe(200);
  });
});

describe("users route guards", () => {
  function signedInAs(role: typeof OP_ROLE) {
    return app((req) => {
      req.session.userId = "caller";
      req.session.username = "caller";
      req.session.roleId = role.id;
      req.session.roleSnapshot = { id: role.id, name: role.name, isProtected: role.isProtected, permissions: role.permissions as any, updatedAt: role.updatedAt.toISOString() };
    });
  }

  it("refuses an operator creating an account on the admin role", async () => {
    prisma.role.findUnique = vi.fn(async () => ADMIN_ROLE);
    const res = await request(signedInAs(OP_ROLE))
      .post("/users")
      .send({ username: "mallory", password: "Correct1!", roleId: "11111111-1111-4111-8111-111111111111" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin-equivalent/);
  });

  it("refuses an operator resetting an administrator's password", async () => {
    user.role = ADMIN_ROLE;
    const res = await request(signedInAs(OP_ROLE)).put("/users/u-alice/password").send({ password: "Correct1!" });
    expect(res.status).toBe(403);
  });
});
