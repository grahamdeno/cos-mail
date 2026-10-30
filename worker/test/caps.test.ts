import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dayKey, nextReset } from "../src/day";
import { allow, call, draftBody, draftReply, extractBody, installFetch, makeEnv, setupKeys, sortBody, type FetchMock } from "./helpers";

let mock: FetchMock;

beforeAll(setupKeys);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T14:00:00Z")); // 10 AM EDT
  mock = await installFetch();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const sortReply = (ids: string[]) => ({
  tool: "record_sort",
  input: { results: ids.map((id) => ({ id, verdict: "needs_you", group: null, reason: "Asks you something." })) },
});

describe("day key and reset time", () => {
  const tz = "America/New_York";
  it("day starts at 4 AM Eastern", () => {
    expect(dayKey(Date.parse("2026-10-30T07:59:00Z"), tz, 4)).toBe("2026-10-29"); // 3:59 AM EDT
    expect(dayKey(Date.parse("2026-10-30T08:00:00Z"), tz, 4)).toBe("2026-10-30"); // 4:00 AM EDT
    expect(dayKey(Date.parse("2026-10-31T03:30:00Z"), tz, 4)).toBe("2026-10-30"); // 11:30 PM EDT
  });
  it("resets_at is the next 4 AM New York time in UTC, across DST", () => {
    expect(nextReset(Date.parse("2026-10-30T14:00:00Z"), tz, 4)).toBe("2026-10-31T08:00:00Z");
    expect(nextReset(Date.parse("2026-10-30T07:30:00Z"), tz, 4)).toBe("2026-10-30T08:00:00Z");
    // DST ends Sun Nov 1 2026: next 4 AM is EST (UTC-5).
    expect(nextReset(Date.parse("2026-11-01T12:00:00Z"), tz, 4)).toBe("2026-11-02T09:00:00Z");
    expect(nextReset(Date.parse("2026-10-31T14:00:00Z"), tz, 4)).toBe("2026-11-01T09:00:00Z");
    // DST starts Sun Mar 14 2027.
    expect(nextReset(Date.parse("2027-03-13T15:00:00Z"), tz, 4)).toBe("2027-03-14T08:00:00Z");
  });
});

describe("daily caps", () => {
  it("21st draft in a day -> 429 daily_limit with resets_at", async () => {
    const { env, kv } = makeEnv();
    await allow(kv);
    for (let i = 0; i < 20; i++) {
      mock.replies.push(draftReply());
      const r = await call(env, "/api/draft", draftBody());
      expect(r.status).toBe(200);
    }
    const r = await call(env, "/api/draft", draftBody());
    expect(r.status).toBe(429);
    expect(r.json.error).toEqual({
      code: "daily_limit",
      message: "You've used today's 20 drafts. More tomorrow after 4 AM.",
      field: null,
      resets_at: "2026-10-31T08:00:00Z",
    });
    expect(mock.anthropicCalls).toHaveLength(20);
    const usageKey = kv.keys("usage:")[0]!;
    expect(usageKey).toMatch(/^usage:[0-9a-f]{16}:2026-10-30$/);
    expect(kv.json(usageKey)).toEqual({ sort: 0, extract: 0, draft: 20, share: 0, labels: 0 });
    expect(kv.store.get(usageKey)!.ttl).toBe(3 * 24 * 3600);

    // After 4 AM the next day the counter is fresh.
    vi.setSystemTime(new Date("2026-10-31T08:00:01Z"));
    mock.replies.push(draftReply());
    expect((await call(env, "/api/draft", draftBody())).status).toBe(200);
  });

  it("daily sort cap is 4, and a 400 does not use up a call", async () => {
    const { env, kv } = makeEnv();
    await allow(kv);
    expect((await call(env, "/api/sort", { messages: [] })).status).toBe(400);
    for (let i = 0; i < 4; i++) {
      mock.replies.push(sortReply(["m0", "m1"]));
      expect((await call(env, "/api/sort", sortBody())).status).toBe(200);
    }
    const r = await call(env, "/api/sort", sortBody());
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("daily_limit");
  });

  it("backfill: allowed once, uses backfill caps that day, then 429 backfill_used", async () => {
    const { env, kv } = makeEnv();
    await allow(kv);
    // Backfill day: 12 sorts allowed (not 4).
    for (let i = 0; i < 12; i++) {
      mock.replies.push(sortReply(["m0", "m1"]));
      expect((await call(env, "/api/sort", sortBody(2, "backfill"))).status).toBe(200);
    }
    expect((await call(env, "/api/sort", sortBody(2, "backfill"))).json.error.code).toBe("daily_limit");
    const bk = kv.keys("backfill:")[0]!;
    expect(bk).toMatch(/^backfill:[0-9a-f]{16}$/);
    expect(kv.json(bk)).toEqual({ at: "2026-10-30T14:00:00Z" });
    expect(kv.store.get(bk)!.ttl).toBe(7 * 24 * 3600);

    // Next day: a second backfill is refused; daily mode still works.
    vi.setSystemTime(new Date("2026-10-31T14:00:00Z"));
    const again = await call(env, "/api/extract", extractBody("backfill"));
    expect(again.status).toBe(429);
    expect(again.json.error.code).toBe("backfill_used");
    expect(again.json.error.resets_at).toBe("2026-11-06T14:00:00Z");
    mock.replies.push(sortReply(["m0", "m1"]));
    expect((await call(env, "/api/sort", sortBody(2, "daily"))).status).toBe(200);
  });

  it("caps are per tester", async () => {
    const { env, kv } = makeEnv();
    await allow(kv);
    await allow(kv, "other@example.com");
    const { idToken } = await import("./helpers");
    for (let i = 0; i < 2; i++) {
      mock.replies.push({ tool: "record_items", input: { commitments: [], decisions: [] } });
      expect((await call(env, "/api/extract", extractBody())).status).toBe(200);
    }
    expect((await call(env, "/api/extract", extractBody())).status).toBe(429);
    mock.replies.push({ tool: "record_items", input: { commitments: [], decisions: [] } });
    const other = await call(env, "/api/extract", extractBody(), { token: await idToken({ email: "other@example.com" }) });
    expect(other.status).toBe(200);
  });
});
