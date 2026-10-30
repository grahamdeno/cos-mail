import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../public/js/api.js";
import { composeDraft, countsFor, flushLabels, gmailQuery, packBatches, pickBrief, runPipeline, tally, todayKey } from "../public/js/flow.js";
import { createGmail } from "../public/js/gmail.js";
import { createStore, memoryAdapter } from "../public/js/store.js";
import { fakeFetch, gmailMsg } from "./helpers.js";

const ME = { email: "me@example.com", name: "Maria" };

function gmailWith(threads) {
  const f = fakeFetch([
    [(c) => c.url.includes("/threads?"), () => ({ threads: threads.map((t) => ({ id: t.id })) })],
    [(c) => /\/threads\/[^?]+\?format=full/.test(c.url), (c) => { const id = c.url.match(/threads\/([^?]+)/)[1]; return threads.find((t) => t.id === id); }],
    [(c) => c.url.includes("/messages?"), () => ({ messages: [] })],
  ]);
  return { gmail: createGmail({ getToken: () => "ACCESS", fetchImpl: f }), calls: f.calls };
}

const T1 = { id: "t1", messages: [gmailMsg({ id: "m1", threadId: "t1", from: "Dana Lee <dana@example.com>", subject: "Install", text: "Can you move my kitchen install from Nov 9 to Nov 16?", internalDate: Date.parse("2026-10-29T12:00:00Z") })] };
const T2 = { id: "t2", messages: [
  gmailMsg({ id: "m2", threadId: "t2", from: "Rachel Park <rachel@example.com>", subject: "Quote", text: "Thanks for the photos.", internalDate: Date.parse("2026-10-20T12:00:00Z") }),
  gmailMsg({ id: "m3", threadId: "t2", from: "Maria <me@example.com>", to: "rachel@example.com", subject: "Re: Quote", text: "I'll send the revised quote with soft-close hinges by Monday.", internalDate: Date.parse("2026-10-21T12:00:00Z"), labelIds: ["SENT"] }),
] };
const T3 = { id: "t3", messages: [gmailMsg({ id: "m4", threadId: "t3", from: "Shop <orders@example.com>", subject: "Receipt", text: "Your invoice #4471 is paid.", internalDate: Date.parse("2026-10-29T10:00:00Z") })] };

function fakeApi({ onSort, onExtract } = {}) {
  const calls = { sort: [], extract: [], draft: [], labels: [] };
  return {
    calls,
    sort: async (b) => { calls.sort.push(b); return onSort ? onSort(b) : { results: b.messages.map((m) => (m.id === "m4" ? { id: m.id, verdict: "handled", group: "receipt", reason: "Paid invoice." } : { id: m.id, verdict: "needs_you", group: null, reason: "Asks a question." })) }; },
    extract: async (b) => { calls.extract.push(b); return onExtract ? onExtract(b) : {
      commitments: [
        { thread_id: "t2", direction: "i_owe", person: "Rachel Park", what: "Send revised quote", quote: "I’ll send the revised quote with soft-close hinges by Monday.", quote_message_id: "m3", due: "2026-10-26", due_kind: "stated", status: "open", confidence: "high" },
        { thread_id: "t2", direction: "i_owe", person: "Rachel Park", what: "Invented promise", quote: "I will repaint your whole house for free", quote_message_id: "m3", due: null, due_kind: null, status: "open", confidence: "low" },
      ],
      decisions: [
        { thread_id: "t1", person: "Dana Lee", question: "Move install to Nov 16?", quote: "move my kitchen install from Nov 9 to Nov 16", quote_message_id: "m1", recommended: { answer: "Yes", reason: "Your week is open." }, alternate: "Not that week", deadline: null, rank: 1 },
        { thread_id: "t1", person: "Dana Lee", question: "Made-up question?", quote: "this text is not in the mail", quote_message_id: "m1", recommended: { answer: "No", reason: "x" }, alternate: "y", deadline: null, rank: 2 },
      ],
      dropped: [],
    }; },
    draft: async (b) => { calls.draft.push(b); return { subject: "Re: Install", body: "Nov 16 works.\n\nMaria", blanks: [] }; },
    labels: async (b) => { calls.labels.push(b); return { ok: true }; },
  };
}

test("backfill: sorts inbound, reads what needs the tester plus the tester's own threads, checks quotes twice", async () => {
  const { gmail, calls } = gmailWith([T1, T2, T3]);
  const api = fakeApi();
  const store = createStore(memoryAdapter());
  const steps = [];
  const r = await runPipeline({ mode: "backfill", gmail, api, store, me: ME, onStep: (s) => steps.push(s.step) });

  assert.equal(api.calls.sort.length, 1);
  assert.equal(api.calls.sort[0].mode, "backfill");
  const sortedIds = api.calls.sort[0].messages.map((m) => m.id).sort();
  assert.deepEqual(sortedIds, ["m1", "m2", "m4"], "the tester's own message is not sorted");
  assert.equal(api.calls.extract.length, 1);
  assert.equal(api.calls.extract[0].mode, "backfill");
  assert.match(api.calls.extract[0].today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(api.calls.extract[0].threads.map((t) => t.thread_id).sort(), ["t1", "t2"], "the receipt thread is not read by the stronger model");

  assert.equal(r.commitments, 1, "the invented promise is dropped by the page");
  assert.equal(r.decisions, 1, "the made-up question is dropped by the page");
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.handled.map((h) => h.id), ["m4"]);

  const ledger = await store.listLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].direction, "i_owe");
  const decisions = await store.listDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "pending");
  assert.equal(await store.getMeta("backfillDone"), true);
  assert.equal((await store.listHandled()).length, 1);
  assert.deepEqual([...new Set(steps)], ["list", "read", "sort", "extract"]);
  for (const c of calls) assert.equal(c.method, "GET", "the pipeline only reads Gmail");
});

test("no message bodies are kept: the store holds only derived items", async () => {
  const { gmail } = gmailWith([T1, T2, T3]);
  const store = createStore(memoryAdapter());
  await runPipeline({ mode: "backfill", gmail, api: fakeApi(), store, me: ME });
  const dump = JSON.stringify({ l: await store.listLedger(), d: await store.listDecisions(), h: await store.listHandled() });
  assert.ok(!dump.includes("Thanks for the photos"), "unrelated body text");
  assert.ok(!dump.includes("Your invoice #4471 is paid"));
});

test("daily mode: asks only for mail since the last brief, with the smaller call budget", async () => {
  const cutoff = Date.parse("2026-10-29T00:00:00Z");
  assert.match(gmailQuery("daily", cutoff), new RegExp(`^after:${cutoff / 1000} `));
  assert.match(gmailQuery("backfill", 0), /^newer_than:30d /);
  assert.match(gmailQuery("daily", cutoff), /-category:promotions -category:social/);
  const { gmail } = gmailWith([T1, T2, T3]);
  const api = fakeApi();
  await runPipeline({ mode: "daily", cutoffMs: cutoff, gmail, api, store: createStore(memoryAdapter()), me: ME });
  assert.equal(api.calls.sort[0].mode, "daily");
  const ids = api.calls.sort[0].messages.map((m) => m.id).sort();
  assert.deepEqual(ids, ["m1", "m4"], "m2 is older than the cutoff");
});

test("a failed sort call leaves messages as 'needs you' (when unsure, show it)", async () => {
  const { gmail } = gmailWith([T1, T3]);
  const api = fakeApi({ onSort: () => { throw new ApiError({ status: 502, code: "model_error", message: "x" }); } });
  const r = await runPipeline({ mode: "daily", cutoffMs: 0, gmail, api, store: createStore(memoryAdapter()), me: ME });
  assert.equal(r.partial, true);
  assert.deepEqual(api.calls.extract[0].threads.map((t) => t.thread_id).sort(), ["t1", "t3"]);
});

test("a daily limit stops the run and is reported, keeping what was found", async () => {
  const { gmail } = gmailWith([T1]);
  const api = fakeApi({ onExtract: () => { throw new ApiError({ status: 429, code: "daily_limit", message: "You've reached today's limit.", resetsAt: "2026-10-31T08:00:00Z" }); } });
  const r = await runPipeline({ mode: "daily", cutoffMs: 0, gmail, api, store: createStore(memoryAdapter()), me: ME });
  assert.equal(r.limit.code, "daily_limit");
  assert.equal(r.commitments, 0);
});

test("a rerun does not bring back a promise the tester dismissed or reset a decision's status", async () => {
  const store = createStore(memoryAdapter());
  const run = () => runPipeline({ mode: "daily", cutoffMs: 0, gmail: gmailWith([T1, T2]).gmail, api: fakeApi(), store, me: ME });
  await run();
  const [item] = await store.listLedger();
  await store.setLedgerStatus(item.id, "dismissed");
  const [dec] = await store.listDecisions();
  await store.patchDecision(dec.id, { status: "drafted" });
  await run();
  assert.equal((await store.listLedger())[0].status, "dismissed");
  assert.equal((await store.listDecisions())[0].status, "drafted");
});

test("batches respect both the item cap and the size cap", () => {
  assert.deepEqual(packBatches([1, 2, 3, 4, 5], { maxItems: 2, sizeOf: () => 1 }).map((b) => b.length), [2, 2, 1]);
  assert.deepEqual(packBatches(["aaaa", "bbbb", "cc"], { maxItems: 50, maxChars: 8, sizeOf: (x) => x.length }).map((b) => b.join("")), ["aaaabbbb", "cc"]);
  assert.deepEqual(packBatches([], { maxItems: 3 }), []);
});

test("the brief shows at most five, oldest first, and skips deferred and finished ones", () => {
  const d = (id, day, rank, extra = {}) => ({ id, status: "pending", firstSeenDay: day, rank, deferUntil: null, ...extra });
  const list = [d("a", "2026-10-30", 1), d("b", "2026-10-28", 2), d("c", "2026-10-28", 1), d("d", "2026-10-29", 1), d("e", "2026-10-30", 2), d("f", "2026-10-30", 3), d("g", "2026-10-30", 4, { deferUntil: "2026-10-31" }), d("h", "2026-10-27", 1, { status: "drafted" })];
  assert.deepEqual(pickBrief(list, "2026-10-30").map((x) => x.id), ["c", "b", "d", "a", "e"]);
  assert.ok(pickBrief(list, "2026-10-31", 10).map((x) => x.id).includes("g"), "a deferred decision comes back on its day");
});

test("the draft call carries the thread, the decision, the answer and recent sent mail", async () => {
  const f = fakeFetch([
    [(c) => /\/threads\/t1\?format=full/.test(c.url), () => T1],
    [(c) => c.url.includes("/messages?"), () => ({ messages: [{ id: "s1" }] })],
    [(c) => c.url.includes("/messages/s1"), () => gmailMsg({ id: "s1", from: "Maria <me@example.com>", to: "dana@example.com", text: "Hi Dana, works for me.\n\nMaria", labelIds: ["SENT"] })],
  ]);
  const gmail = createGmail({ getToken: () => "A", fetchImpl: f });
  const api = fakeApi();
  const d = await composeDraft({ gmail, api, me: ME, decision: { thread_id: "t1", question: "Move install to Nov 16?", recommended: { answer: "Yes", reason: "r" } }, answer: { kind: "recommended", text: "Yes" }, shorter: true });
  const sent = api.calls.draft[0];
  assert.equal(sent.thread_id, "t1");
  assert.equal(sent.shorter, true);
  assert.deepEqual(sent.answer, { kind: "recommended", text: "Yes" });
  assert.equal(sent.decision.recommended, "Yes");
  assert.equal(sent.style_examples.length, 1);
  assert.match(sent.style_examples[0].body, /works for me/);
  assert.equal(d.meta.to, "dana@example.com");
  assert.equal(d.meta.inReplyTo, "<m1@mail.example.com>");
  assert.equal(d.subject, "Re: Install");
});

test("label counts have no text, and unsent days are sent once", async () => {
  const store = createStore(memoryAdapter());
  await store.addLabel({ type: "not_a_promise", thread_id: "t1", day: "2026-10-29" });
  await store.addLabel({ type: "draft_edited", thread_id: "t1", ratio: 0.25, day: "2026-10-29" });
  await store.addLabel({ type: "draft_edited", thread_id: "t2", ratio: 0.5, day: "2026-10-29" });
  await store.addLabel({ type: "draft_unchanged", thread_id: "t3", ratio: 0, day: "2026-10-30" });
  assert.deepEqual(countsFor(await store.listLabels().then((l) => l.filter((x) => x.day === "2026-10-29"))), { not_a_promise: 1, draft_edited: 2, edit_ratio_sum: 0.75 });
  const api = fakeApi();
  assert.equal(await flushLabels({ store, api }), 4);
  assert.deepEqual(api.calls.labels.map((c) => c.day), ["2026-10-29", "2026-10-30"]);
  for (const c of api.calls.labels) assert.deepEqual(Object.keys(c).sort(), ["counts", "day"]);
  assert.equal(await flushLabels({ store, api }), 0, "sent labels are not sent again");
  // A failed call keeps the labels for next time.
  await store.addLabel({ type: "needed_me", thread_id: "t9", day: "2026-10-30" });
  const failing = { labels: async () => { throw new ApiError({ status: 500, code: "internal", message: "x" }); } };
  assert.equal(await flushLabels({ store, api: failing }), 0);
  assert.equal((await store.unsentLabels()).length, 1);
});

test("the Done numbers", async () => {
  const store = createStore(memoryAdapter());
  const today = todayKey();
  for (let i = 0; i < 3; i++) await store.addLabel({ type: "draft_unchanged", day: today });
  await store.addLabel({ type: "draft_edited", ratio: 0.3, day: today });
  await store.setMeta("unchangedTotal", 21);
  await store.upsertLedger([{ id: "x", direction: "i_owe", status: "open" }, { id: "y", direction: "owed_to_me", status: "open" }, { id: "z", direction: "i_owe", status: "dismissed" }]);
  const t = await tally(store, today);
  assert.equal(t.unchangedWeek, 3);
  assert.equal(t.savedWeek, 4);
  assert.equal(t.openMine, 1);
  assert.equal(t.openTheirs, 1);
  assert.equal(t.toLevel3, 29);
});
