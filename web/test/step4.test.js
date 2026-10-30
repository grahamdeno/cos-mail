import test from "node:test";
import assert from "node:assert/strict";
import { checkQuote, emailOf } from "../public/js/quote.js";
import { checkQuote as workerCheck, emailOf as workerEmailOf } from "../../worker/src/quote.ts";
import { redactSecrets } from "../public/js/trim.js";
import { isSelfAddress, runPipeline, writtenToOthers } from "../public/js/flow.js";
import { createGmail, parseMessage } from "../public/js/gmail.js";
import { createStore, memoryAdapter } from "../public/js/store.js";
import { fakeFetch, gmailMsg } from "./helpers.js";

const msgs = new Map([
  ["a", { thread_id: "t1", from: "Pat Quinn <pat@example.com>", body: "I’ll call you Monday about the trim order." }],
  ["b", { thread_id: "t1", from: "Dave Lee <DAVE@example.com>", body: "Can you confirm 40 board feet? I will send the invoice Friday." }],
  ["c", { thread_id: "t2", from: "pat@example.com", body: "Sure, Thursday works for me." }],
]);
const cases = [];
for (const [t, q, m] of [
  ["t1", "I'll call you Monday", "a"], ["t2", "Thursday works for me", "c"], ["t1", "I will send the invoice Friday", "b"],
  ["t1", "Can you confirm 40 board feet?", "b"], ["t1", "about the trim order", "a"], ["t1", "Thursday works for me", "c"],
  ["t1", "I'll call you Monday", "zzz"], ["t1", "I'll call you Tuesday", "a"], ["t1", "Monday", "a"], ["t1", "  call  ", "a"],
  ["t1", "I'll call you ... trim order", "a"], ["t1", "", "a"],
]) for (const kind of ["i_owe", "owed_to_me", "decision"]) cases.push([{ thread_id: t, quote: q, quote_message_id: m }, kind]);

test("the page's item check gives the same verdict as the Worker's on every case", () => {
  for (const [item, kind] of cases) {
    assert.equal(checkQuote(item, kind, msgs, "Pat@Example.com"), workerCheck(item, kind, msgs, "Pat@Example.com"), `${kind} ${JSON.stringify(item)}`);
  }
  for (const f of ["Dave Lee <DAVE@example.com>", " pat@example.com ", '"Lee, Dave" <d@x.com>', "weird"]) assert.equal(emailOf(f), workerEmailOf(f));
});

test("speaker rule: a promise must be in the right person's words", () => {
  assert.equal(checkQuote({ thread_id: "t1", quote: "I'll call you Monday", quote_message_id: "a" }, "i_owe", msgs, "pat@example.com"), null);
  assert.equal(checkQuote({ thread_id: "t1", quote: "I will send the invoice Friday", quote_message_id: "b" }, "i_owe", msgs, "pat@example.com"), "wrong_speaker");
  assert.equal(checkQuote({ thread_id: "t1", quote: "I will send the invoice Friday", quote_message_id: "b" }, "owed_to_me", msgs, "pat@example.com"), null);
});

test("self addresses: the tester's own and copies with both names; not family who share a last name", () => {
  const me = { email: "pat.quinn@example.com", name: "Pat Quinnley" };
  assert.ok(isSelfAddress("pat.quinn@example.com", me));
  assert.ok(isSelfAddress("Pat <PAT.QUINN@example.com>", me));
  assert.ok(isSelfAddress("patsquinnleyctr@agency.example", me));
  assert.ok(isSelfAddress("patquinnley@work.example", me));
  assert.ok(!isSelfAddress("quinnleyjo@example.com", me), "spouse");
  assert.ok(!isSelfAddress("samquinnley@student.example", me), "child");
  assert.ok(!isSelfAddress("notes@capture.example", me));
  assert.ok(!isSelfAddress("pat@other.example", { email: "x@y.com", name: "Pat" }), "one-word names never match by name");
});

test("a note to self is not mail written to others", () => {
  const me = { email: "pat.quinn@example.com", name: "Pat Quinnley" };
  const m = (from, to, cc = []) => ({ from, to, cc });
  assert.equal(writtenToOthers(m("pat.quinn@example.com", ["patquinnleyctr@agency.example"]), me), false);
  assert.equal(writtenToOthers(m("pat.quinn@example.com", ["pat.quinn@example.com"]), me), false);
  assert.equal(writtenToOthers(m("pat.quinn@example.com", ["patquinnleyctr@agency.example"], ["quinnleyjo@example.com"]), me), true);
  assert.equal(writtenToOthers(m("dana@example.com", ["pat.quinn@example.com"]), me), false);
});

test("keys and tokens are blanked before mail leaves the phone", () => {
  const ant = "sk-" + "ant-api03-" + "A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWx";
  const pplx = "pplx-" + "0123456789abcdefABCDEF0123";
  const gh = "gh" + "p_" + "0123456789abcdefghijABCDEFGHIJ0123";
  const goog = "AI" + "za" + "SyA-0123456789abcdefghijklmnopqrstu";
  const pem = "-----BEGIN RSA PRIV" + "ATE KEY-----\nMIIEow\nabc\n-----END RSA PRIV" + "ATE KEY-----";
  const s = `Subject: ${ant} ${pplx}\nmy token ${gh} and ${goog}\n${pem}\nTalk soon`;
  const out = redactSecrets(s);
  for (const secret of [ant, pplx, gh, goog, "MIIEow"]) assert.ok(!out.includes(secret), secret.slice(0, 8));
  assert.match(out, /Talk soon/);
  assert.equal((out.match(/\[key removed\]/g) ?? []).length, 5);
  // Ordinary words are left alone.
  for (const plain of ["task-list for Monday", "risk-assessment draft", "Ask Dana about the AKIA conference", "sk-8 night"]) assert.equal(redactSecrets(plain), plain);
});

test("Gmail parsing scrubs keys in subjects and bodies", () => {
  const key = "sk-" + "ant-api03-" + "Z9y8X7w6V5u4T3s2R1q0PpOoNnMmLlKk";
  const m = parseMessage(gmailMsg({ id: "k1", from: "Pat <pat.quinn@example.com>", subject: `${key} pplx`, text: `here it is ${key}` }));
  assert.ok(!m.subject.includes(key) && !m.body.includes(key));
  assert.match(m.subject, /\[key removed\]/);
});

test("pipeline: notes to self are neither sorted nor read; a real reply still is", async () => {
  const me = { email: "pat.quinn@example.com", name: "Pat Quinnley" };
  const threads = {
    n1: [gmailMsg({ id: "n1", threadId: "n1", from: "Pat Quinnley <pat.quinn@example.com>", to: "patquinnleyctr@agency.example", subject: "Jira upload", text: "I'll upload the backlog tomorrow." })],
    n2: [gmailMsg({ id: "n2", threadId: "n2", from: "Pat Quinnley <patquinnleyctr@agency.example>", to: "pat.quinn@example.com", subject: "Photo", text: "photo attached" })],
    r1: [gmailMsg({ id: "r1", threadId: "r1", from: "Pat Quinnley <pat.quinn@example.com>", to: "teacher@school.example", subject: "Absence", text: "Sam will be out Friday. I'll pick up his homework Thursday." })],
  };
  const f = fakeFetch([
    [(c) => c.url.includes("/threads?"), () => ({ threads: Object.keys(threads).map((id) => ({ id })) })],
    [(c) => /\/threads\/[^?]+\?/.test(c.url), (c) => { const id = c.url.match(/threads\/([^?]+)/)[1]; return { id, messages: threads[id] }; }],
  ]);
  const seen = { sort: [], extract: [] };
  const api = {
    sort: async (b) => { seen.sort.push(...b.messages.map((m) => m.id)); return { results: b.messages.map((m) => ({ id: m.id, verdict: "needs_you", group: null, reason: "x" })) }; },
    extract: async (b) => { seen.extract.push(...b.threads.map((t) => t.thread_id)); return { commitments: [], decisions: [], dropped: [] }; },
  };
  await runPipeline({ mode: "backfill", gmail: createGmail({ getToken: () => "A", fetchImpl: f }), api, store: createStore(memoryAdapter()), me });
  assert.deepEqual(seen.sort, [], "nothing inbound from another person");
  assert.deepEqual(seen.extract, ["r1"]);
});

test("pipeline: the page drops a promise attributed to the wrong person even if the Worker let it through", async () => {
  const me = { email: "pat.quinn@example.com", name: "Pat Quinnley" };
  const t = [
    gmailMsg({ id: "x1", threadId: "x1", from: "Dana Lee <dana@example.com>", subject: "Invoice", text: "I will send the invoice Friday." }),
    gmailMsg({ id: "x2", threadId: "x1", from: "Pat Quinnley <pat.quinn@example.com>", to: "dana@example.com", subject: "Re: Invoice", text: "Thanks, I'll pay it the same day." }),
  ];
  const f = fakeFetch([
    [(c) => c.url.includes("/threads?"), () => ({ threads: [{ id: "x1" }] })],
    [(c) => /\/threads\/x1\?/.test(c.url), () => ({ id: "x1", messages: t })],
  ]);
  const c = (direction, quote, quote_message_id) => ({ thread_id: "x1", direction, person: "Dana Lee", what: "x", quote, quote_message_id, due: null, due_kind: null, status: "open", confidence: "high" });
  const api = {
    sort: async (b) => ({ results: b.messages.map((m) => ({ id: m.id, verdict: "needs_you", group: null, reason: "x" })) }),
    extract: async () => ({
      commitments: [c("owed_to_me", "I will send the invoice Friday", "x1"), c("i_owe", "I'll pay it the same day", "x2"), c("i_owe", "I will send the invoice Friday", "x1")],
      decisions: [],
      dropped: [],
    }),
  };
  const store = createStore(memoryAdapter());
  const r = await runPipeline({ mode: "backfill", gmail: createGmail({ getToken: () => "A", fetchImpl: f }), api, store, me });
  assert.equal(r.commitments, 2);
  assert.equal(r.dropped, 1);
  const dirs = (await store.listLedger()).map((l) => l.direction).sort();
  assert.deepEqual(dirs, ["i_owe", "owed_to_me"]);
});
