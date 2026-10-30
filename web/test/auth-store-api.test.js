import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApi } from "../public/js/api.js";
import { createAuth, decodeJwt } from "../public/js/auth.js";
import { createGmail } from "../public/js/gmail.js";
import { assertNoSecrets, createStore, memoryAdapter } from "../public/js/store.js";
import { fakeFetch } from "./helpers.js";

const jwt = (claims) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmF0dXJl`;
const ID_TOKEN = jwt({ email: "Me@Example.com", name: "Maria Ruiz", given_name: "Maria", exp: Math.floor(Date.now() / 1000) + 3600 });
// Built by concatenation so the repo scan does not mistake this fake for a real token.
const ACCESS_TOKEN = "ya" + "29.ACCESS-TOKEN-FOR-GMAIL-ONLY-0123456789";

/** A fake Google Identity Services. */
function fakeGoogle() {
  let credentialCb, tokenCb;
  return {
    accounts: {
      id: {
        initialize: (o) => { credentialCb = o.callback; },
        prompt: () => credentialCb({ credential: ID_TOKEN }),
        renderButton: () => {},
        disableAutoSelect: () => {},
      },
      oauth2: {
        initTokenClient: (o) => { tokenCb = o.callback; return { requestAccessToken: () => tokenCb({ access_token: ACCESS_TOKEN, expires_in: 3600 }) }; },
        revoke: (t, done) => { fakeGoogle.revoked = t; done(); },
      },
    },
  };
}

test("tokens live in memory only: nothing touches any browser storage", async () => {
  const touched = [];
  const spy = (name) => new Proxy({}, { get: (_, k) => (...a) => { touched.push(`${name}.${String(k)}`); }, set: (_, k) => { touched.push(`${name}.${String(k)}=`); return true; } });
  const saved = {};
  for (const n of ["localStorage", "sessionStorage", "indexedDB", "caches", "document"]) { saved[n] = Object.getOwnPropertyDescriptor(globalThis, n); Object.defineProperty(globalThis, n, { value: spy(n), configurable: true, writable: true }); }
  try {
    const g = fakeGoogle();
    const auth = createAuth({ google: () => g });
    let signedIn = false;
    auth.init(() => { signedIn = true; });
    auth.prompt();
    assert.ok(signedIn);
    assert.equal(auth.profile.email, "me@example.com");
    assert.equal(await auth.getIdToken(), ID_TOKEN);
    await auth.requestAccess();
    assert.equal(auth.getAccessToken(), ACCESS_TOKEN);
    auth.signOut();
    assert.equal(auth.getAccessToken(), null);
    assert.equal(auth.signedIn, false);
  } finally {
    for (const [n, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; }
  }
  assert.deepEqual(touched, []);
});

test("the Worker gets only the ID token; Gmail gets only the access token", async () => {
  const g = fakeGoogle();
  const auth = createAuth({ google: () => g });
  auth.init(() => {});
  auth.prompt();
  await auth.requestAccess();

  const workerFetch = fakeFetch([[() => true, () => ({ results: [] })]]);
  const gmailFetch = fakeFetch([[() => true, () => ({ emailAddress: "me@example.com", threads: [] })]]);
  const api = createApi({ getIdToken: () => auth.getIdToken(), base: "/api", fetchImpl: workerFetch });
  const gmail = createGmail({ getToken: () => auth.getAccessToken(), fetchImpl: gmailFetch });
  await api.sort({ mode: "daily", messages: [{ id: "m1", body: "hello" }] });
  await gmail.getProfileEmail();

  const w = workerFetch.calls[0];
  assert.equal(w.headers.Authorization, `Bearer ${ID_TOKEN}`);
  assert.ok(!JSON.stringify(w).includes(ACCESS_TOKEN), "the access token never reaches the Worker");
  const m = gmailFetch.calls[0];
  assert.equal(m.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.ok(!JSON.stringify(m).includes(ID_TOKEN));
  auth.signOut();
  assert.equal(g.revoked ?? fakeGoogle.revoked, ACCESS_TOKEN, "sign out revokes the access token");
});

test("an expired access token is treated as none", async () => {
  let t = 0;
  const g = fakeGoogle();
  const auth = createAuth({ google: () => g, now: () => t });
  auth.init(() => {});
  await auth.requestAccess();
  assert.ok(auth.hasAccess());
  t = 3600 * 1000 - 30_000; // inside the last minute
  assert.equal(auth.getAccessToken(), null);
});

test("JWT claims decode with non-ASCII names", () => {
  assert.equal(decodeJwt(jwt({ name: "José Ñandú", email: "j@x.com" })).name, "José Ñandú");
});

test("API errors keep the Worker's plain message, code and reset time", async () => {
  const f = fakeFetch([[() => true, () => ({ status: 429, body: { error: { code: "daily_limit", message: "You've reached today's limit. More tomorrow after 4 AM.", field: null, resets_at: "2026-10-31T08:00:00Z" } } })]]);
  const api = createApi({ getIdToken: async () => "t", base: "/api", fetchImpl: f });
  await assert.rejects(api.draft({}), (e) => e instanceof ApiError && e.status === 429 && e.code === "daily_limit" && e.resetsAt === "2026-10-31T08:00:00Z" && /4 AM/.test(e.message));
  const off = createApi({ getIdToken: async () => "t", base: "/api", fetchImpl: async () => { throw new Error("net"); } });
  await assert.rejects(off.sort({}), (e) => e.code === "offline");
});

test("a 401 is retried once with a fresh ID token, then given up", async () => {
  let n = 0;
  const tokens = ["old", "new"];
  const f = fakeFetch([[() => true, (c) => (c.headers.Authorization === "Bearer new" ? { ok: true } : { status: 401, body: { error: { code: "unauthorized", message: "expired" } } })]]);
  const api = createApi({ getIdToken: async () => tokens[Math.min(n++, 1)], base: "/api", fetchImpl: f });
  assert.deepEqual(await api.labels({ day: "2026-10-30", counts: {} }), { ok: true });
  assert.equal(f.calls.length, 2);
  const always = fakeFetch([[() => true, () => ({ status: 401, body: { error: { code: "unauthorized", message: "no" } } })]]);
  const api2 = createApi({ getIdToken: async () => "x", base: "/api", fetchImpl: always });
  await assert.rejects(api2.sort({}), (e) => e.code === "unauthorized");
  assert.equal(always.calls.length, 2);
});

test("the store refuses credentials", async () => {
  const store = createStore(memoryAdapter());
  assert.throws(() => assertNoSecrets({ access_token: "x" }), /credential/);
  assert.throws(() => assertNoSecrets({ a: { b: ["ya" + "29.abcdefghijklmnop"] } }), /credential/);
  assert.throws(() => assertNoSecrets({ note: ID_TOKEN }), /credential/);
  await assert.rejects(store.setMeta("t", ACCESS_TOKEN), /credential/);
  await assert.rejects(store.upsertLedger([{ id: "1", authorization: "Bearer x" }]), /credential/);
  assert.doesNotThrow(() => assertNoSecrets({ quote: "I'll send the token budget by Monday", person: "Dana" }));
});

test("purge drops finished items and sent labels after 30 days, and keeps the rest", async () => {
  const DAY = 86_400_000;
  let now = Date.parse("2026-09-01T12:00:00Z");
  const store = createStore(memoryAdapter(), { now: () => now });
  const label = await store.addLabel({ type: "not_a_promise", day: "2026-09-01" }); // created "now"
  await store.markSent([label.id]);
  const unsent = await store.addLabel({ type: "needed_me", day: "2026-09-01" }); // never sent: kept
  now = Date.parse("2026-10-01T12:00:00Z"); // 30 days later
  const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();
  await store.upsertLedger([
    { id: "old-done", status: "dismissed", doneAt: iso(31) },
    { id: "new-done", status: "dismissed", doneAt: iso(5) },
    { id: "open", status: "open", doneAt: null },
  ]);
  await store.upsertDecisions([
    { id: "old-drafted", status: "drafted", decidedAt: iso(31) },
    { id: "new-drafted", status: "drafted", decidedAt: iso(5) },
    { id: "pending", status: "pending", decidedAt: null, firstSeenDay: "2026-08-01" },
  ]);
  now += 1 * DAY; // the sent label is now 31 days old
  await store.purge();
  assert.deepEqual((await store.listLedger()).map((x) => x.id).sort(), ["new-done", "open"]);
  assert.deepEqual((await store.listDecisions()).map((x) => x.id).sort(), ["new-drafted", "pending"]);
  assert.deepEqual((await store.listLabels()).map((x) => x.id), [unsent.id]);
});

test("sign-out clears everything", async () => {
  const store = createStore(memoryAdapter());
  await store.setMeta("backfillDone", true);
  await store.upsertLedger([{ id: "a", status: "open" }]);
  await store.addLabel({ type: "needed_me", day: "2026-10-30" });
  await store.clearAll();
  assert.equal(await store.getMeta("backfillDone"), null);
  assert.equal((await store.listLedger()).length + (await store.listLabels()).length, 0);
});
