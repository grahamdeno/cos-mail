import { callTool } from "../claude";
import { DAY_RE } from "../day";
import { badRequest } from "../errors";
import { EXTRACT_TOOL, extractSystem, mailBlock } from "../prompts";
import { checkQuote, type DropReason, type QuotedMessage } from "../quote";
import { ID_MAX, arr, isObj, obj, str } from "../validate";
import type { Handler } from "./context";
import { optSubject, parseMessage, parseMode } from "./mail";

export interface Commitment {
  thread_id: string;
  direction: "i_owe" | "owed_to_me";
  person: string;
  what: string;
  quote: string;
  quote_message_id: string;
  due: string | null;
  due_kind: "stated" | "implied" | null;
  status: "open" | "done" | "possibly_done";
  confidence: "high" | "low";
}

export interface Decision {
  thread_id: string;
  person: string;
  question: string;
  quote: string;
  quote_message_id: string;
  recommended: { answer: string; reason: string };
  alternate: string;
  deadline: string | null;
  rank: number;
}

export interface Dropped {
  thread_id: string;
  kind: "commitment" | "decision";
  reason: DropReason;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const inEnum = <T>(v: unknown, values: readonly T[]): v is T => values.includes(v as T);

function parseCommitment(c: unknown): Commitment | null {
  if (!isObj(c)) return null;
  if (!isStr(c.thread_id) || !isStr(c.person) || !isStr(c.what) || !isStr(c.quote) || !isStr(c.quote_message_id)) return null;
  if (!inEnum(c.direction, ["i_owe", "owed_to_me"] as const)) return null;
  const due = c.due ?? null;
  const due_kind = c.due_kind ?? null;
  if (!isStrOrNull(due) || !inEnum(due_kind, ["stated", "implied", null] as const)) return null;
  if (!inEnum(c.status, ["open", "done", "possibly_done"] as const)) return null;
  if (!inEnum(c.confidence, ["high", "low"] as const)) return null;
  return {
    thread_id: c.thread_id,
    direction: c.direction,
    person: c.person,
    what: c.what.slice(0, 120),
    quote: c.quote,
    quote_message_id: c.quote_message_id,
    due,
    due_kind,
    status: c.status,
    confidence: c.confidence,
  };
}

function parseDecision(d: unknown): Decision | null {
  if (!isObj(d)) return null;
  if (!isStr(d.thread_id) || !isStr(d.person) || !isStr(d.question) || !isStr(d.quote) || !isStr(d.quote_message_id)) return null;
  const rec = d.recommended;
  if (!isObj(rec) || !isStr(rec.answer) || !isStr(rec.reason)) return null;
  if (!isStr(d.alternate)) return null;
  const deadline = d.deadline ?? null;
  if (!isStrOrNull(deadline)) return null;
  if (typeof d.rank !== "number" || !Number.isInteger(d.rank) || d.rank < 1) return null;
  return {
    thread_id: d.thread_id,
    person: d.person,
    question: d.question.slice(0, 160),
    quote: d.quote,
    quote_message_id: d.quote_message_id,
    recommended: { answer: rec.answer.slice(0, 60), reason: rec.reason.slice(0, 140) },
    alternate: d.alternate.slice(0, 60),
    deadline,
    rank: d.rank,
  };
}

/** Validate the model's record_items input. Any malformed item makes the whole call invalid (retried once). */
export function parseExtractOutput(input: unknown): { commitments: Commitment[]; decisions: Decision[] } | null {
  if (!isObj(input) || !Array.isArray(input.commitments) || !Array.isArray(input.decisions)) return null;
  const commitments: Commitment[] = [];
  for (const c of input.commitments) {
    const p = parseCommitment(c);
    if (!p) return null;
    commitments.push(p);
  }
  const decisions: Decision[] = [];
  for (const d of input.decisions) {
    const p = parseDecision(d);
    if (!p) return null;
    decisions.push(p);
  }
  return { commitments, decisions };
}

/**
 * Quote check in the Worker (A7, tightened in step 4): see checkQuote. The page runs the same check again.
 */
export function quoteCheck(
  messages: Map<string, QuotedMessage>,
  out: { commitments: Commitment[]; decisions: Decision[] },
  testerEmail: string,
): { commitments: Commitment[]; decisions: Decision[]; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const commitments = out.commitments.filter((c) => {
    const reason = checkQuote(c, c.direction, messages, testerEmail);
    if (reason) dropped.push({ thread_id: c.thread_id, kind: "commitment", reason });
    return !reason;
  });
  const decisions = out.decisions
    .filter((d) => {
      const reason = checkQuote(d, "decision", messages, testerEmail);
      if (reason) dropped.push({ thread_id: d.thread_id, kind: "decision", reason });
      return !reason;
    })
    .sort((a, b) => a.rank - b.rank)
    .map((d, i) => ({ ...d, rank: i + 1 }));
  return { commitments, decisions, dropped };
}

/** The model call for /extract. Shared with the prompt eval (worker/eval) so both send exactly the same thing. */
export function extractCall(model: string, tester: { name: string; email: string }, today: string, threads: unknown[]) {
  return {
    model,
    system: extractSystem(tester.name, tester.email, today),
    user: `Find the commitments and decisions in these ${threads.length} threads.\n\n${mailBlock(threads)}`,
    tool: EXTRACT_TOOL,
    maxTokens: 8000,
    temperature: 0,
    parse: parseExtractOutput,
  };
}

export const extract: Handler = async (ctx) => {
  const body = obj(ctx.body, "body");
  const mode = parseMode(body);
  const today = str(body, "today", "today");
  if (!DAY_RE.test(today)) throw badRequest("today");
  const rawThreads = arr(body, "threads", "threads", { min: 1, max: 20 });
  const index = new Map<string, QuotedMessage>();
  const threads = rawThreads.map((t, i) => {
    const field = `threads[${i}]`;
    const o = obj(t, field);
    const thread_id = str(o, "thread_id", `${field}.thread_id`, { nonEmpty: true, max: ID_MAX });
    const subject = optSubject(o, `${field}.subject`);
    const rawMsgs = arr(o, "messages", `${field}.messages`, { min: 1, max: 15 });
    const messages = rawMsgs.map((m, j) => {
      const msg = parseMessage(m, `${field}.messages[${j}]`, { requireTo: true });
      if (index.has(msg.id)) throw badRequest(`${field}.messages[${j}].id`);
      index.set(msg.id, { thread_id, from: msg.from, body: msg.body });
      return msg;
    });
    return { thread_id, subject, messages };
  });

  await ctx.charge("extract", mode);

  const out = await callTool(ctx.env, extractCall(ctx.env.MODEL_EXTRACT, ctx.tester, today, threads), ctx.meter);

  const checked = quoteCheck(index, out, ctx.tester.email);
  return { ...checked, usage: { input_tokens: ctx.meter.in, output_tokens: ctx.meter.out } };
};
