/**
 * Live prompt eval: sends the synthetic cases in ./cases.ts to the real models through the same
 * calls the Worker makes, then scores the answers. Needs ANTHROPIC_API_KEY; skipped without it.
 *
 *   npm run eval          (from worker/)
 *
 * It prints every item the model returned (the mail is synthetic) and writes a summary for CI.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_URL, ANTHROPIC_VERSION, callTool, requestBody, type Meter } from "../src/claude";
import { draftCall } from "../src/endpoints/draft";
import { extractCall, quoteCheck, type Commitment, type Decision } from "../src/endpoints/extract";
import { completeResults, sortCall } from "../src/endpoints/sort";
import type { Env } from "../src/env";
import { normalize, type QuotedMessage } from "../src/quote";
import { CASES, DRAFT_CASES, SORT_CASES, TESTER, TODAY } from "./cases";

const KEY = process.env.ANTHROPIC_API_KEY ?? "";
const env = { ANTHROPIC_API_KEY: KEY } as unknown as Env;
const MODELS = { sort: process.env.MODEL_SORT ?? "claude-haiku-5-5", extract: process.env.MODEL_EXTRACT ?? "claude-sonnet-5-5", draft: process.env.MODEL_DRAFT ?? "claude-sonnet-5-5" };

const lines: string[] = [];
const say = (s = "") => { lines.push(s); console.log(s); };
let flushed = 0;
const flush = () => {
  const chunk = lines.slice(flushed);
  flushed = lines.length;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, chunk.join("\n") + "\n");
  // Also as one annotation per section, so the results can be read through the checks API.
  if (process.env.GITHUB_ACTIONS) {
    const msg = chunk.join("\n").slice(0, 60000).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::notice title=${(chunk[0] ?? "eval").replace(/[#:,]/g, "").trim()}::${msg}`);
  }
};
const overlaps = (quote: string, phrase: string) => { const q = normalize(quote), p = normalize(phrase); return q.includes(p) || p.includes(q) || (q.length > 12 && p.includes(q.slice(0, Math.floor(q.length * 0.6)))); };
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${Math.round((100 * a) / b)}%`);

describe.skipIf(!KEY)("prompt eval (live models)", () => {
  // Diagnostics: the Worker never reads API error text (it could echo mail). Here the mail is synthetic,
  // so print the status and error message of the exact request shape, to catch shape problems early.
  it("preflight: the request shape is accepted for each model", async () => {
    const results: string[] = [];
    const shapes: Array<[string, ReturnType<typeof sortCall> | ReturnType<typeof extractCall> | ReturnType<typeof draftCall>]> = [
      ["sort", sortCall(MODELS.sort, TESTER, SORT_CASES.slice(0, 1).map((c) => c.msg))],
      ["extract", extractCall(MODELS.extract, TESTER, TODAY, CASES.slice(0, 1).map((c) => c.thread))],
      ["draft", draftCall(MODELS.draft, TESTER, DRAFT_CASES[0]!.data, false)],
    ];
    for (const [name, call] of shapes) {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify(requestBody(call as Parameters<typeof requestBody>[0])),
      });
      const text = await res.text();
      let detail = "";
      try {
        const j = JSON.parse(text);
        if (res.ok) {
          const block = (j.content ?? []).find((c: { type: string; text?: string }) => c.type === "text");
          let parsed = "no text block";
          if (block) {
            try { parsed = (call.parse as (x: unknown) => unknown)(JSON.parse(block.text)) === null ? `parse rejected: ${String(block.text).slice(0, 700)}` : "parse ok"; }
            catch (e) { parsed = `parse threw ${String(e)}: ${String(block.text).slice(0, 300)}`; }
          }
          detail = `stop=${j.stop_reason} blocks=${(j.content ?? []).map((c: { type: string }) => c.type).join(",")} ${parsed}`;
        } else detail = `${j.error?.type}: ${j.error?.message}`;
      } catch { detail = text.slice(0, 300); }
      results.push(`${name} (${call.model}): HTTP ${res.status} ${detail}`);
    }
    say("## Preflight");
    for (const r of results) say(`- ${r}`);
    say();
    flush();
    expect(results.every((r) => r.includes("HTTP 200") && r.includes("parse ok"))).toBe(true);
  }, 120_000);

  it("extract: promises and decisions", async () => {
    const meter: Meter = { model: null, in: 0, out: 0 };
    const threads = CASES.map((c) => c.thread);
    const out = await callTool(env, extractCall(MODELS.extract, TESTER, TODAY, threads), meter);
    const index = new Map<string, QuotedMessage>();
    for (const t of threads) for (const m of t.messages) index.set(m.id, { thread_id: t.thread_id, from: m.from, body: m.body });
    const checked = quoteCheck(index, out, TESTER.email);

    let expC = 0, hitC = 0, expD = 0, hitD = 0, extraC = 0, extraD = 0, dueOk = 0, dueN = 0, statusOk = 0, statusN = 0;
    const forbiddenHits: string[] = [];
    const misses: string[] = [];
    const extras: string[] = [];
    for (const c of CASES) {
      const tid = c.thread.thread_id;
      const gotC = checked.commitments.filter((x) => x.thread_id === tid);
      const gotD = checked.decisions.filter((x) => x.thread_id === tid);
      const usedC = new Set<Commitment>();
      for (const e of c.commitments ?? []) {
        expC++;
        const g = gotC.find((x) => !usedC.has(x) && x.direction === e.direction && overlaps(x.quote, e.phrase));
        if (!g) { misses.push(`${tid} ${e.direction}: "${e.phrase}"`); continue; }
        usedC.add(g); hitC++;
        if (e.due) { dueN++; if (g.due === e.due) dueOk++; else misses.push(`${tid} due ${g.due} (want ${e.due})`); }
        if (e.status) { statusN++; if (g.status === e.status) statusOk++; else misses.push(`${tid} status ${g.status} (want ${e.status})`); }
      }
      for (const x of gotC) if (!usedC.has(x)) { extraC++; extras.push(`${tid} ${x.direction} [${x.confidence}]: "${x.quote}"`); }
      const usedD = new Set<Decision>();
      for (const e of c.decisions ?? []) {
        expD++;
        const g = gotD.find((x) => !usedD.has(x) && overlaps(x.quote, e.phrase));
        if (!g) { misses.push(`${tid} decision: "${e.phrase}"`); continue; }
        usedD.add(g); hitD++;
      }
      for (const x of gotD) if (!usedD.has(x) && !c.optionalDecision) { extraD++; extras.push(`${tid} decision: "${x.question}"`); }
      for (const f of c.forbidden ?? []) {
        const all = [...gotC.map((x) => `${x.quote} ${x.what}`), ...gotD.map((x) => `${x.quote} ${x.question}`)];
        if (all.some((s) => normalize(s).includes(normalize(f)))) forbiddenHits.push(`${tid}: "${f}"`);
      }
    }

    say(`## Extract (${MODELS.extract})`);
    say(`- Promises found: ${hitC}/${expC} (${pct(hitC, expC)}). Extra promises: ${extraC}.`);
    say(`- Decisions found: ${hitD}/${expD} (${pct(hitD, expD)}). Extra decisions: ${extraD}.`);
    say(`- Due dates right: ${dueOk}/${dueN}. Status right: ${statusOk}/${statusN}.`);
    say(`- Dropped by the quote check: ${checked.dropped.length} (${checked.dropped.map((d) => `${d.thread_id} ${d.reason}`).join(", ") || "none"}).`);
    say(`- Must-not-find hits: ${forbiddenHits.length ? forbiddenHits.join("; ") : "none"}.`);
    say(`- Tokens: ${meter.in} in, ${meter.out} out.`);
    if (misses.length) { say("\nMisses:"); for (const s of misses) say(`- ${s}`); }
    if (extras.length) { say("\nExtras:"); for (const s of extras) say(`- ${s}`); }
    say("\nEverything returned:");
    for (const x of checked.commitments) say(`- ${x.thread_id} ${x.direction} ${x.status} ${x.confidence} due=${x.due}: ${x.what} | "${x.quote}"`);
    for (const x of checked.decisions) say(`- ${x.thread_id} decision #${x.rank}: ${x.question} -> ${x.recommended.answer} (${x.recommended.reason})`);
    say();
    flush();

    expect(forbiddenHits, "no invented or injected promises").toEqual([]);
    expect(hitC / expC, "promise recall").toBeGreaterThanOrEqual(0.85);
    expect(hitD / expD, "decision recall").toBeGreaterThanOrEqual(0.75);
    expect(extraC, "extra promises").toBeLessThanOrEqual(2);
  }, 240_000);

  it("sort: nothing that needs the tester is hidden", async () => {
    const meter: Meter = { model: null, in: 0, out: 0 };
    const msgs = SORT_CASES.map((c) => c.msg);
    const raw = await callTool(env, sortCall(MODELS.sort, TESTER, msgs), meter);
    const results = completeResults(msgs.map((m) => m.id), raw);
    let hidden = 0, extra = 0;
    const notes: string[] = [];
    for (const c of SORT_CASES) {
      const r = results.find((x) => x.id === c.msg.id)!;
      if (c.expect === "needs_you" && r.verdict === "handled") { hidden++; notes.push(`HIDDEN ${c.msg.id} "${c.msg.subject}": ${r.reason}`); }
      if (c.expect === "handled" && r.verdict === "needs_you") { extra++; notes.push(`extra ${c.msg.id} "${c.msg.subject}": ${r.reason}`); }
    }
    say(`## Sort (${MODELS.sort})`);
    say(`- Needs-you mail hidden: ${hidden}. Handled mail shown anyway: ${extra}. Tokens: ${meter.in} in, ${meter.out} out.`);
    for (const n of notes) say(`- ${n}`);
    for (const r of results) say(`  - ${r.id} ${r.verdict}${r.group ? `/${r.group}` : ""}: ${r.reason}`);
    say();
    flush();
    expect(hidden, "needs-you mail hidden").toBe(0);
    expect(extra, "noise shown").toBeLessThanOrEqual(2);
  }, 120_000);

  it("draft: plain, short, in the tester's answer, no invented facts", async () => {
    say(`## Draft (${MODELS.draft})`);
    const problems: string[] = [];
    for (const c of DRAFT_CASES) {
      const meter: Meter = { model: null, in: 0, out: 0 };
      const d = await callTool(env, draftCall(MODELS.draft, TESTER, c.data, c.shorter), meter);
      const words = d.body.split(/\s+/).filter(Boolean).length;
      const p: string[] = [];
      for (const re of c.mustInclude) if (!re.test(d.body)) p.push(`missing ${re}`);
      for (const re of c.mustNotInclude) if (re.test(d.body)) p.push(`has ${re}`);
      if (words > c.maxWords) p.push(`${words} words > ${c.maxWords}`);
      if (!/^re:/i.test(d.subject)) p.push(`subject "${d.subject}"`);
      say(`- ${c.name}: ${p.length ? p.join("; ") : "ok"} (${words} words)`);
      say("  > " + d.body.replace(/\n/g, "\n  > "));
      problems.push(...p.map((x) => `${c.name}: ${x}`));
    }
    say();
    flush();
    expect(problems).toEqual([]);
  }, 240_000);
});
