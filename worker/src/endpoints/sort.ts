import { callTool } from "../claude";
import { badRequest } from "../errors";
import { SORT_TOOL, mailBlock, sortSystem } from "../prompts";
import { ID_MAX, SHORT_MAX, arr, isObj, obj, str, strArray } from "../validate";
import type { Handler } from "./context";
import { parseMessage, parseMode } from "./mail";

const GROUPS = ["receipt", "newsletter", "fyi", "answered_by_other"] as const;
type Group = (typeof GROUPS)[number];

export interface SortResult {
  id: string;
  verdict: "needs_you" | "handled";
  group: Group | null;
  reason: string;
}

export const NOT_SORTED_REASON = "Not sorted; shown to be safe.";

/** Validate the model's record_sort input. Returns null if it is not the right shape. */
export function parseSortOutput(input: unknown): SortResult[] | null {
  if (!isObj(input) || !Array.isArray(input.results)) return null;
  const out: SortResult[] = [];
  for (const r of input.results) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.reason !== "string") return null;
    if (r.verdict !== "needs_you" && r.verdict !== "handled") return null;
    const g = r.group;
    if (g !== null && g !== undefined && !(GROUPS as readonly unknown[]).includes(g)) return null;
    out.push({ id: r.id, verdict: r.verdict, group: (g ?? null) as Group | null, reason: r.reason });
  }
  return out;
}

/** Every input id exactly once, in input order; missing ids are needs_you (A6). */
export function completeResults(ids: string[], model: SortResult[]): SortResult[] {
  const byId = new Map<string, SortResult>();
  for (const r of model) if (!byId.has(r.id)) byId.set(r.id, r);
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return { id, verdict: "needs_you", group: null, reason: NOT_SORTED_REASON };
    const reason = r.reason.trim().slice(0, 140) || (r.verdict === "needs_you" ? "Needs you." : "Handled.");
    if (r.verdict === "needs_you") return { id, verdict: "needs_you", group: null, reason };
    return { id, verdict: "handled", group: r.group ?? "fyi", reason };
  });
}

export const sort: Handler = async (ctx) => {
  const body = obj(ctx.body, "body");
  const mode = parseMode(body);
  const raw = arr(body, "messages", "messages", { min: 1, max: 50 });
  const seen = new Set<string>();
  const messages = raw.map((m, i) => {
    const field = `messages[${i}]`;
    const base = parseMessage(m, field, { requireTo: true });
    const o = obj(m, field);
    const thread_id = str(o, "thread_id", `${field}.thread_id`, { nonEmpty: true, max: ID_MAX });
    const subject = str(o, "subject", `${field}.subject`, { max: SHORT_MAX });
    const labels = strArray(o, "labels", `${field}.labels`, { optional: true, maxItems: 50 });
    if (seen.has(base.id)) throw badRequest(`${field}.id`);
    seen.add(base.id);
    return { id: base.id, thread_id, from: base.from, to: base.to, cc: base.cc, date: base.date, subject, labels, body: base.body };
  });

  await ctx.charge("sort", mode);

  const model = await callTool(
    ctx.env,
    {
      model: ctx.env.MODEL_SORT,
      system: sortSystem(ctx.tester.name, ctx.tester.email),
      user: `Sort these ${messages.length} messages.\n\n${mailBlock(messages)}`,
      tool: SORT_TOOL,
      maxTokens: 4000,
      temperature: 0,
      parse: parseSortOutput,
    },
    ctx.meter,
  );

  return {
    results: completeResults(
      messages.map((m) => m.id),
      model,
    ),
    usage: { input_tokens: ctx.meter.in, output_tokens: ctx.meter.out },
  };
};
