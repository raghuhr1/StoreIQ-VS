import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import { authFromToken } from "@/server/auth/context";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, hashToken, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { createJob, getJob } from "@/server/services/jobs";
import { createProfileVersion } from "@/server/services/profiles";
import { openOutput } from "@/server/services/results";
import { createStore } from "@/server/services/stores";
import { createMember, listAudit, listMembers } from "@/server/services/users";
import { login } from "@/server/services/auth";
import { registerAnchor } from "@/server/services/anchors";
import { addUser, ctxFor, drainQueue, makeTenant, PASSWORD, streamToString, upload } from "../helpers/server";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
beforeAll(async () => {
  t = await makeTenant("sec");
});

describe("passwords and sessions", () => {
  it("hashes with scrypt and verifies in constant time", async () => {
    const h = await hashPassword("a long enough password");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("a long enough password", h)).toBe(true);
    expect(await verifyPassword("wrong password here", h)).toBe(false);
  });

  it("rejects wrong passwords with a generic message", async () => {
    await expect(
      login({ email: t.email, password: "nope-nope-nope" }, { ip: "1.1.1.1", requestId: "r" }),
    ).rejects.toThrow("Invalid email or password");
    await expect(
      login({ email: "nobody@example.test", password: PASSWORD }, { ip: "1.1.1.1", requestId: "r" }),
    ).rejects.toThrow("Invalid email or password");
  });

  it("rate-limits repeated login attempts", async () => {
    let limited = false;
    for (let i = 0; i < 15; i++) {
      try {
        await login({ email: t.email, password: "bad-password-xx" }, { ip: "9.9.9.9", requestId: "r" });
      } catch (e) {
        if (/Too many/.test((e as Error).message)) limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  it("stores only token hashes and rejects expired, idle or unknown sessions", async () => {
    const { token } = await createSession(t.admin.userId, t.admin.tenantId);
    expect(await db().session.findUnique({ where: { id: token } })).toBeNull();
    expect(await db().session.findUnique({ where: { id: hashToken(token) } })).not.toBeNull();
    expect(await authFromToken(token, { requestId: "r", ip: null })).not.toBeNull();
    await db().session.update({
      where: { id: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await authFromToken(token, { requestId: "r", ip: null })).toBeNull();
    const idle = await createSession(t.admin.userId, t.admin.tenantId);
    await db().session.update({
      where: { id: hashToken(idle.token) },
      data: { lastSeenAt: new Date(Date.now() - 24 * 3600_000) },
    });
    expect(await authFromToken(idle.token, { requestId: "r", ip: null })).toBeNull();
    expect(await authFromToken("forged-token", { requestId: "r", ip: null })).toBeNull();
  });
});

describe("role-based access control", () => {
  it("restricts administrative and write actions by role", async () => {
    const viewer = await addUser(t.admin, "VIEWER");
    const operator = await addUser(t.admin, "OPERATOR");
    await expect(createStore(viewer, { name: "V", code: "V1" })).rejects.toThrow(/permission/);
    await expect(createStore(operator, { name: "O", code: "O1" })).rejects.toThrow(/permission/);
    await expect(
      createMember(operator, { email: "x@example.test", name: "x", role: "ADMIN" }),
    ).rejects.toThrow(/permission/);
    await expect(listMembers(viewer)).rejects.toThrow(/permission/);
    await expect(listAudit(operator, { limit: 1, offset: 0 })).rejects.toThrow(/permission/);
    await expect(createProfileVersion(operator, { name: "Default", config: {} })).rejects.toThrow(
      /permission/,
    );
    await expect(
      registerAnchor(viewer, t.store.id, { epc: "E28011000000000000000001", zoneId: t.sf.id }),
    ).rejects.toThrow(/permission/);
    await expect(
      upload(viewer, t.store.id, "v.csv", "EPC\nE28011000000000000000001\n", { zoneId: t.sf.id }),
    ).rejects.toThrow(/permission/);

    const u = await upload(operator, t.store.id, "op.csv", "EPC\nE28011000000000000000001\n", {
      zoneId: t.sf.id,
    });
    const { job } = await createJob(operator, {
      storeId: t.store.id,
      inputs: [{ uploadId: u.upload.id, mapping: { epc: "EPC" } }],
    });
    await drainQueue();
    expect((await getJob(viewer, job.id)).status).toBe("COMPLETED");
    await expect(openOutput(viewer, job.id, "exceptions")).rejects.toThrow(/permission/);
  });

  it("requires a temporary password to be changed before API use", async () => {
    const { temporaryPassword, email } = await createMember(t.admin, {
      email: `tmp-${Date.now()}@example.test`,
      name: "Tmp",
      role: "MANAGER",
    });
    const ctx = await ctxFor(email, temporaryPassword!);
    expect(ctx.mustChangePassword).toBe(true);
    const handler = apiRoute({ permission: "store:read" }, async () => ({ data: "ok" }));
    const res = await handler(
      new Request("http://localhost:3000/api/v1/stores", {
        headers: { cookie: `${SESSION_COOKIE}=${ctx.token}` },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("API wrapper protections", () => {
  const handler = apiRoute({ permission: "store:write" }, async () => ({ data: "ok" }));

  it("rejects unauthenticated requests with a structured error", async () => {
    const res = await handler(
      new Request("http://localhost:3000/api/v1/x", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.requestId).toBeTruthy();
  });

  it("rejects cross-site state-changing requests (CSRF)", async () => {
    const cookie = `${SESSION_COOKIE}=${t.admin.token}`;
    const evil = await handler(
      new Request("http://localhost:3000/api/v1/x", {
        method: "POST",
        headers: { cookie, origin: "https://evil.example" },
      }),
    );
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe("CSRF_REJECTED");
    const site = await handler(
      new Request("http://localhost:3000/api/v1/x", {
        method: "POST",
        headers: { cookie, "sec-fetch-site": "cross-site" },
      }),
    );
    expect(site.status).toBe(403);
    const ok = await handler(
      new Request("http://localhost:3000/api/v1/x", {
        method: "POST",
        headers: { cookie, origin: "http://localhost:3000" },
      }),
    );
    expect(ok.status).toBe(200);
  });
});

describe("malicious and malformed uploads", () => {
  it("rejects binary, spreadsheet, non-UTF-8, empty and wrongly named files", async () => {
    const s = t.store.id;
    await expect(upload(t.admin, s, "evil.csv", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).rejects.toThrow(
      /binary|XLSX/i,
    );
    await expect(
      upload(t.admin, s, "evil.csv", Buffer.from([0x45, 0x50, 0x43, 0x0a, 0xff, 0xfe, 0x0a])),
    ).rejects.toThrow(/UTF-8/);
    await expect(upload(t.admin, s, "empty.csv", "")).rejects.toThrow(/empty/i);
    await expect(upload(t.admin, s, "script.exe", "EPC\nA\n")).rejects.toThrow(/Only \.csv/);
    await expect(upload(t.admin, s, "scan.xlsx", "EPC\nA\n")).rejects.toThrow(/Only \.csv/);
  });

  it("neutralises path traversal in file names", async () => {
    const r = await upload(
      t.admin,
      t.store.id,
      "../../../etc/passwd.csv",
      "EPC\nE28011000000000000000001\n",
      { zoneId: t.sf.id },
    );
    expect(r.upload.originalFilename).toBe("passwd.csv");
  });

  it("enforces the upload size limit while streaming", async () => {
    const prev = process.env.MAX_UPLOAD_BYTES;
    const { config } = await import("@/server/config");
    const c = config();
    const original = c.MAX_UPLOAD_BYTES;
    c.MAX_UPLOAD_BYTES = 1024;
    try {
      await expect(
        upload(t.admin, t.store.id, "big.csv", "EPC\n" + "E28011000000000000000001\n".repeat(200), {
          zoneId: t.sf.id,
        }),
      ).rejects.toThrow(/exceeds/);
    } finally {
      c.MAX_UPLOAD_BYTES = original;
      process.env.MAX_UPLOAD_BYTES = prev;
    }
  });

  it("protects exported CSV files against formula injection end to end", async () => {
    const text =
      "EPC,Zone,Session\nE28011000000000000000001,SF,\"=cmd|' /C calc'!A0\"\nE28011000000000000000002,SF,@SUM(1)\n";
    const u = await upload(t.admin, t.store.id, "inj.csv", text);
    const { job } = await createJob(t.admin, {
      storeId: t.store.id,
      inputs: [{ uploadId: u.upload.id, mapping: { epc: "EPC", zone: "Zone", session: "Session" } }],
    });
    await drainQueue();
    const out = await openOutput(t.admin, job.id, "observed_inventory");
    const rows = parse(await streamToString((out as { body: ReadableStream<Uint8Array> }).body), {
      columns: true,
    }) as Record<string, string>[];
    for (const r of rows) for (const v of Object.values(r)) expect(v).not.toMatch(/^[=+@]/);
    expect(rows.map((r) => r.scan_session_id)).toEqual(["'=cmd|' /C calc'!A0", "'@SUM(1)"]);
  });
});
