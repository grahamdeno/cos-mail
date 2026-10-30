// The work, in order: list threads, sort every message, read only what needs the tester, check every quote,
// keep the results on this phone. Bodies stay in memory and are dropped when a run ends.
import { CONFIG } from "./config.js";
import { addDays, daysBetween, dayKey } from "./day.js";
import { buildRaw, parseAddress, pickRecipient } from "./gmail.js";
import { checkQuote, normalize } from "./quote.js";
import { ApiError } from "./api.js";

export const todayKey = (nowMs = Date.now()) => dayKey(nowMs, CONFIG.dayTz, CONFIG.dayStartHour);

export function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Group items into calls: at most `maxItems` each and `maxChars` of JSON each (the Worker's body limit is 400 KB). */
export function packBatches(items, { maxItems, maxChars = CONFIG.maxBatchChars, sizeOf = (x) => JSON.stringify(x).length }) {
  const out = [];
  let cur = [], size = 0;
  for (const it of items) {
    const s = sizeOf(it);
    if (cur.length && (cur.length >= maxItems || size + s > maxChars)) { out.push(cur); cur = []; size = 0; }
    cur.push(it);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

export const sortPayload = (m) => ({ id: m.id, thread_id: m.thread_id, from: m.from, to: m.to, cc: m.cc, date: m.date, subject: m.subject, labels: m.labels, body: m.body });
export const extractPayloadMsg = (m) => ({ id: m.id, from: m.from, to: m.to, cc: m.cc, date: m.date, body: m.body });

export function gmailQuery(mode, cutoffMs) {
  const base = "(in:inbox OR in:sent) -category:promotions -category:social";
  return mode === "backfill" ? `newer_than:${CONFIG.backfill.days}d ${base}` : `after:${Math.floor(cutoffMs / 1000)} ${base}`;
}

const stopCodes = new Set(["daily_limit", "backfill_used"]);

/**
 * True for the tester's own address, or another address that carries both their first and last name
 * (a work or school copy of themselves). Family who share a last name do not match.
 */
export function isSelfAddress(addr, me) {
  const email = parseAddress(addr).email;
  if (!email) return false;
  if (email === me.email.toLowerCase()) return true;
  const tokens = String(me.name ?? "").toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z]/g, "")).filter((t) => t.length >= 3);
  if (tokens.length < 2) return false;
  const local = email.split("@")[0].replace(/[^a-z]/g, "");
  return local.includes(tokens[0]) && local.includes(tokens[tokens.length - 1]);
}

/** A message the tester wrote to at least one other person (not a note to self). */
export function writtenToOthers(m, me) {
  if (!isSelfAddress(m.from, me)) return false;
  return [...m.to, ...m.cc].some((a) => !isSelfAddress(a, me));
}

export function toLedgerItem(c, dayNow) {
  return {
    id: `${c.thread_id}:${hashStr(normalize(c.quote))}`,
    thread_id: c.thread_id,
    direction: c.direction,
    person: c.person,
    what: c.what,
    quote: c.quote,
    due: c.due,
    due_kind: c.due_kind,
    status: c.status,
    confidence: c.confidence,
    firstSeen: dayNow,
    doneAt: c.status === "done" ? new Date().toISOString() : null,
  };
}

export function toDecision(d, dayNow) {
  return {
    id: `${d.thread_id}:${hashStr(normalize(d.question))}`,
    thread_id: d.thread_id,
    person: d.person,
    question: d.question,
    quote: d.quote,
    quote_message_id: d.quote_message_id,
    recommended: d.recommended,
    alternate: d.alternate,
    deadline: d.deadline,
    rank: d.rank,
    source: "model",
    status: "pending",
    firstSeenDay: dayNow,
    deferUntil: null,
    deferrals: 0,
    decidedAt: null,
  };
}

/** The decisions to show today: pending and not deferred past today, oldest first, at most five. */
export function pickBrief(decisions, today, max = CONFIG.maxDecisions) {
  return decisions
    .filter((d) => d.status === "pending" && (!d.deferUntil || d.deferUntil <= today))
    .sort((a, b) => (a.firstSeenDay < b.firstSeenDay ? -1 : a.firstSeenDay > b.firstSeenDay ? 1 : a.rank - b.rank))
    .slice(0, max);
}

/**
 * Run a backfill or a daily brief.
 * deps: { gmail, api, store, me: {email}, now?, onStep? }
 */
export async function runPipeline({ mode, cutoffMs = 0, gmail, api, store, me, now = Date.now, onStep = /** @type {(s: any) => void} */ (() => {}) }) {
  const cfg = mode === "backfill" ? CONFIG.backfill : CONFIG.daily;
  const meEmail = me.email.toLowerCase();
  const today = todayKey(now());
  const out = { mode, scanned: 0, sortedCount: 0, handled: [], commitments: 0, decisions: 0, dropped: 0, partial: false, limit: null };

  onStep({ step: "list" });
  const ids = await gmail.listThreadIds({ q: gmailQuery(mode, cutoffMs), max: cfg.maxThreads });
  onStep({ step: "read", done: 0, total: ids.length });
  const threads = await gmail.getThreads(ids, (done) => onStep({ step: "read", done, total: ids.length }));
  out.scanned = threads.reduce((n, t) => n + t.messages.length, 0);

  // 1. Sort inbound messages. Newest first, as many as this mode's calls allow.
  const inbound = threads
    .flatMap((t) => t.messages)
    .filter((m) => !isSelfAddress(m.from, me) && m.internalMs >= cutoffMs) // notes from the tester's other addresses are not sorted
    .sort((a, b) => b.internalMs - a.internalMs)
    .slice(0, cfg.sortCalls * CONFIG.sortPerCall);
  const verdict = new Map();
  const sortBatches = packBatches(inbound.map(sortPayload), { maxItems: CONFIG.sortPerCall });
  for (const [i, batch] of sortBatches.slice(0, cfg.sortCalls).entries()) {
    onStep({ step: "sort", done: i * CONFIG.sortPerCall, total: inbound.length });
    try {
      const r = await api.sort({ mode, messages: batch });
      for (const x of r.results) verdict.set(x.id, x);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (stopCodes.has(e.code)) { out.limit = e; break; }
      if (e.code === "model_error" || e.code === "too_large") { out.partial = true; continue; }
      throw e;
    }
  }
  out.sortedCount = verdict.size;

  const byId = new Map(inbound.map((m) => [m.id, m]));
  const needThreads = new Set();
  const handled = [];
  for (const m of inbound) {
    const v = verdict.get(m.id);
    if (!v || v.verdict === "needs_you") needThreads.add(m.thread_id); // when unsure, it needs the tester
    else handled.push({ id: m.id, thread_id: m.thread_id, group: v.group ?? "fyi", reason: v.reason, from: m.fromName, subject: m.subject, day: todayKey(m.internalMs), internalMs: m.internalMs });
  }
  out.handled = handled;

  // 2. Read only what needs the tester, plus threads where the tester wrote (their own promises).
  // Notes to self (all recipients are the tester) are skipped: no promises to anyone, and no cost.
  const mine = new Set(threads.filter((t) => t.messages.some((m) => writtenToOthers(m, me) && m.internalMs >= cutoffMs)).map((t) => t.thread_id));
  const wanted = threads
    .filter((t) => needThreads.has(t.thread_id) || mine.has(t.thread_id))
    .sort((a, b) => Number(needThreads.has(b.thread_id)) - Number(needThreads.has(a.thread_id)) || b.messages.at(-1).internalMs - a.messages.at(-1).internalMs)
    .slice(0, cfg.extractCalls * CONFIG.extractPerCall);

  const sent = new Map(); // message id -> { thread_id, from, body } exactly as sent, for the quote check
  const payloads = wanted.map((t) => {
    const msgs = t.messages.slice(-CONFIG.threadMsgMax);
    for (const m of msgs) sent.set(m.id, { thread_id: t.thread_id, from: m.from, body: m.body });
    return { thread_id: t.thread_id, subject: t.subject, messages: msgs.map(extractPayloadMsg) };
  });

  const commitments = [];
  const decisions = [];
  const exBatches = packBatches(payloads, { maxItems: CONFIG.extractPerCall });
  for (const [i, batch] of exBatches.slice(0, cfg.extractCalls).entries()) {
    onStep({ step: "extract", done: i, total: Math.min(exBatches.length, cfg.extractCalls) });
    try {
      const r = await api.extract({ mode, today, threads: batch });
      commitments.push(...r.commitments);
      decisions.push(...r.decisions);
      out.dropped += r.dropped?.length ?? 0;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (stopCodes.has(e.code)) { out.limit = e; break; }
      if (e.code === "model_error" || e.code === "too_large") { out.partial = true; continue; }
      throw e;
    }
  }

  // 3. The page checks every item again against the text it sent: right thread, real words, right speaker.
  const okC = commitments.filter((c) => !checkQuote(c, c.direction, sent, meEmail));
  const okD = decisions.filter((d) => !checkQuote(d, "decision", sent, meEmail));
  out.dropped += commitments.length - okC.length + decisions.length - okD.length;
  out.commitments = okC.length;
  out.decisions = okD.length;

  // 4. Keep derived items only.
  await store.upsertLedger(okC.map((c) => toLedgerItem(c, today)));
  await store.upsertDecisions(okD.sort((a, b) => a.rank - b.rank).map((d) => toDecision(d, today)));
  const prev = mode === "backfill" ? [] : await store.listHandled();
  await store.replaceHandled([...handled.map(({ internalMs, ...h }) => h), ...prev.filter((p) => daysBetween(p.day, today) < 1 && !byId.has(p.id))]);
  await store.setMeta("lastBriefMs", now());
  await store.setMeta("briefDay", today);
  if (mode === "backfill") { await store.setMeta("backfillDone", true); await store.setMeta("backfillScanned", out.scanned); }
  await store.setMeta("handledToday", handled.length);
  return out;
}

// ---------- drafts ----------

/** Ask the Worker for a draft. Mail is fetched fresh and dropped after the call. */
export async function composeDraft({ gmail, api, me, decision, answer, shorter = false }) {
  const thread = await gmail.getThread(decision.thread_id);
  const to = pickRecipient(thread.messages, me.email);
  const style = to.email ? await gmail.getSentTo(to.email) : [];
  const res = await api.draft({
    thread_id: decision.thread_id,
    subject: thread.subject,
    messages: thread.messages.slice(-CONFIG.draftMsgMax).map(extractPayloadMsg),
    decision: { question: decision.question, recommended: decision.recommended.answer },
    answer,
    style_examples: style.slice(0, CONFIG.styleExamples).map((m) => ({ to: m.to.join(", "), date: m.date, body: m.body })),
    shorter,
  });
  const last = to.message;
  const subject = res.subject?.trim() || (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`);
  const refs = [last?.references, last?.messageIdHeader].filter(Boolean).join(" ");
  return {
    subject,
    body: res.body,
    blanks: res.blanks ?? [],
    meta: { threadId: decision.thread_id, to: to.email, toName: to.name, inReplyTo: last?.messageIdHeader ?? "", references: refs },
  };
}

/** Create the Gmail draft, or update the one this app already made for this reply. Never sends. */
export async function saveToGmail({ gmail, draft, body, existingId = null }) {
  const raw = buildRaw({ to: draft.meta.to, subject: draft.subject, body, inReplyTo: draft.meta.inReplyTo, references: draft.meta.references });
  const payload = { threadId: draft.meta.threadId, raw };
  return existingId ? gmail.updateDraft(existingId, payload) : gmail.createDraft(payload);
}

// ---------- labels ----------

const COUNT_KEY = { not_a_promise: "not_a_promise", needed_me: "needed_me", missed_one: "missed_one", draft_unchanged: "draft_unchanged", draft_edited: "draft_edited", opened_gmail_yes: "opened_gmail_yes", opened_gmail_no: "opened_gmail_no" };

/** Counts for one day, in the shape POST /labels takes. No text. */
export function countsFor(labels) {
  const c = {};
  for (const l of labels) {
    const k = COUNT_KEY[l.type];
    if (!k) continue;
    c[k] = (c[k] ?? 0) + 1;
    if (l.type === "draft_edited" && typeof l.ratio === "number") c.edit_ratio_sum = (c.edit_ratio_sum ?? 0) + l.ratio;
  }
  return c;
}

/** Send unsent labels, one call per day of labels, oldest first, at most `maxCalls` (the Worker allows 4 a day). */
export async function flushLabels({ store, api, maxCalls = 3 }) {
  const unsent = await store.unsentLabels();
  const days = [...new Set(unsent.map((l) => l.day))].sort().slice(0, maxCalls);
  let sent = 0;
  for (const day of days) {
    const group = unsent.filter((l) => l.day === day);
    try {
      await api.labels({ day, counts: countsFor(group) });
    } catch (e) {
      if (e instanceof ApiError) break; // try again next time; the labels stay on the phone
      throw e;
    }
    await store.markSent(group.map((l) => l.id));
    sent += group.length;
  }
  return sent;
}

// ---------- Done screen numbers ----------

export async function tally(store, today) {
  const [ledger, labels] = await Promise.all([store.listLedger(), store.listLabels()]);
  const weekAgo = addDays(today, -6);
  const week = labels.filter((l) => l.day >= weekAgo);
  const unchanged = week.filter((l) => l.type === "draft_unchanged").length;
  const edited = week.filter((l) => l.type === "draft_edited").length;
  const total = (await store.getMeta("unchangedTotal", 0)) || 0;
  return {
    unchangedWeek: unchanged,
    savedWeek: unchanged + edited,
    openMine: ledger.filter((c) => c.direction === "i_owe" && c.status === "open").length,
    openTheirs: ledger.filter((c) => c.direction === "owed_to_me" && c.status === "open").length,
    unchangedTotal: total,
    toLevel3: Math.max(0, CONFIG.unchangedForLevel3 - total),
  };
}
