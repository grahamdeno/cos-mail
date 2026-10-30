import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { allow, call, idToken, installFetch, makeEnv, setupKeys, sortBody, type FetchMock } from "./helpers";

let mock: FetchMock;

beforeAll(setupKeys);
beforeEach(async () => {
  mock = await installFetch();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const { env, kv } = makeEnv();
  await allow(kv);
  return env;
}

describe("auth and origin", () => {
  it("no token -> 401 unauthorized", async () => {
    const env = await setup();
    const r = await call(env, "/api/sort", sortBody(), { token: null });
    expect(r.status).toBe(401);
    expect(r.json.error).toEqual({ code: "unauthorized", message: expect.any(String), field: null, resets_at: null });
    expect(mock.anthropicCalls).toHaveLength(0);
  });

  it("malformed token -> 401", async () => {
    const env = await setup();
    expect((await call(env, "/api/sort", sortBody(), { token: "not.a.jwt" })).status).toBe(401);
    expect((await call(env, "/api/sort", sortBody(), { token: "garbage" })).status).toBe(401);
  });

  it("bad signature -> 401", async () => {
    const env = await setup();
    const r = await call(env, "/api/sort", sortBody(), { token: await idToken({ wrongKey: true }) });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("unauthorized");
  });

  it("unknown kid -> 401", async () => {
    const env = await setup();
    expect((await call(env, "/api/sort", sortBody(), { token: await idToken({ kid: "nope" }) })).status).toBe(401);
  });

  it("wrong aud -> 401", async () => {
    const env = await setup();
    const r = await call(env, "/api/sort", sortBody(), { token: await idToken({ aud: "someone-else.apps.googleusercontent.com" }) });
    expect(r.status).toBe(401);
  });

  it("wrong iss -> 401", async () => {
    const env = await setup();
    const r = await call(env, "/api/sort", sortBody(), { token: await idToken({ iss: "https://evil.example.com" }) });
    expect(r.status).toBe(401);
  });

  it("expired beyond 60 s skew -> 401; within skew passes auth", async () => {
    const env = await setup();
    expect((await call(env, "/api/sort", sortBody(), { token: await idToken({ expIn: -61 }) })).status).toBe(401);
    // Within skew: passes auth and reaches the body check (empty messages -> 400, no model call).
    const r = await call(env, "/api/sort", { messages: [] }, { token: await idToken({ expIn: -30 }) });
    expect(r.status).toBe(400);
  });

  it("email_verified false or missing -> 401", async () => {
    const env = await setup();
    expect((await call(env, "/api/sort", sortBody(), { token: await idToken({ email_verified: false }) })).status).toBe(401);
    expect((await call(env, "/api/sort", sortBody(), { token: await idToken({ email_verified: "true" }) })).status).toBe(401);
  });

  it("not on allowlist -> 403 not_on_list", async () => {
    const env = await setup();
    const r = await call(env, "/api/sort", sortBody(), { token: await idToken({ email: "stranger@example.com" }) });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("not_on_list");
  });

  it("allowlist lookup lowercases the email", async () => {
    const env = await setup();
    const r = await call(env, "/api/sort", { messages: [] }, { token: await idToken({ email: "Maria.Tester@Example.com" }) });
    expect(r.status).toBe(400); // got past the allowlist
  });

  it("bad or missing origin -> 403 bad_origin, without CORS headers", async () => {
    const env = await setup();
    for (const origin of ["https://evil.example.com", null, "null", "https://cos.tangomike.app.evil.com", "http://cos.tangomike.app"]) {
      const r = await call(env, "/api/sort", sortBody(), { origin });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("bad_origin");
      expect(r.res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("localhost on any port is allowed and gets CORS", async () => {
    const env = await setup();
    for (const origin of ["http://localhost", "http://localhost:5173", "http://localhost:8787"]) {
      const r = await call(env, "/api/sort", { messages: [] }, { origin });
      expect(r.status).toBe(400);
      expect(r.res.headers.get("access-control-allow-origin")).toBe(origin);
    }
    expect((await call(env, "/api/sort", sortBody(), { origin: "https://localhost:5173" })).status).toBe(403);
  });

  it("OPTIONS preflight from an allowed origin -> 204 with CORS, no token needed", async () => {
    const env = await setup();
    const r = await call(env, "/api/sort", null, { method: "OPTIONS", token: null });
    expect(r.status).toBe(204);
    expect(r.res.headers.get("access-control-allow-origin")).toBe("https://cos.tangomike.app");
    expect(r.res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("Google certs are cached per cache-control", async () => {
    const env = await setup();
    await call(env, "/api/sort", { messages: [] });
    await call(env, "/api/sort", { messages: [] });
    await call(env, "/api/sort", { messages: [] });
    expect(mock.certCalls).toBe(1);
  });

  it("5 requests with an unknown kid inside a minute cause exactly 1 certs fetch", async () => {
    const env = await setup();
    for (let i = 0; i < 5; i++) {
      const r = await call(env, "/api/sort", sortBody(), { token: await idToken({ kid: "rotated-kid" }) });
      expect(r.status).toBe(401);
    }
    expect(mock.certCalls).toBe(1);
    // Known kids keep working from the cache with no extra fetch.
    expect((await call(env, "/api/sort", { messages: [] })).status).toBe(400);
    expect(mock.certCalls).toBe(1);
  });

  it("unknown kid on a fresh cache refetches at most once per 60 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-30T14:00:00Z"));
      const env = await setup();
      expect((await call(env, "/api/sort", { messages: [] })).status).toBe(400); // primes the cache
      expect(mock.certCalls).toBe(1);
      vi.setSystemTime(new Date("2026-10-30T14:01:01Z")); // cache still fresh (max-age 6 h), 61 s later
      for (let i = 0; i < 5; i++) {
        expect((await call(env, "/api/sort", sortBody(), { token: await idToken({ kid: "rotated-kid" }) })).status).toBe(401);
        vi.setSystemTime(new Date(Date.now() + 10_000));
      }
      expect(mock.certCalls).toBe(2);
      vi.setSystemTime(new Date("2026-10-30T14:02:05Z")); // more than 60 s after the refetch
      expect((await call(env, "/api/sort", sortBody(), { token: await idToken({ kid: "rotated-kid" }) })).status).toBe(401);
      expect(mock.certCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("404 unknown path and 405 non-POST (after auth)", async () => {
    const env = await setup();
    const nf = await call(env, "/api/nope", {});
    expect(nf.status).toBe(404);
    expect(nf.json.error.code).toBe("not_found");
    const na = await call(env, "/api/sort", null, { method: "GET" });
    expect(na.status).toBe(405);
    expect(na.json.error.code).toBe("method_not_allowed");
    expect((await call(env, "/api/nope", {}, { token: null })).status).toBe(401);
  });

  it("body over 400 KB -> 413 too_large; invalid JSON -> 400", async () => {
    const env = await setup();
    const big = JSON.stringify({ messages: [], pad: "x".repeat(400 * 1024) });
    const r = await call(env, "/api/sort", null, { rawBody: big });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("too_large");
    const bad = await call(env, "/api/sort", null, { rawBody: "{not json" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.field).toBe("body");
  });

  it("missing secrets -> 500 internal without echoing the request", async () => {
    const { env, kv } = makeEnv();
    await allow(kv);
    env.EMAIL_HASH_KEY = "";
    const r = await call(env, "/api/sort", sortBody());
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe("internal");
    expect(JSON.stringify(r.json)).not.toContain("Install");
  });
});
