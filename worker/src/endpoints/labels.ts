import { DAY_RE } from "../day";
import { badRequest } from "../errors";
import { obj, str } from "../validate";
import type { Handler } from "./context";

export const LABEL_KEYS = [
  "not_a_promise",
  "needed_me",
  "missed_one",
  "draft_unchanged",
  "draft_edited",
  "edit_ratio_sum",
  "opened_gmail_yes",
  "opened_gmail_no",
] as const;

export const LABELS_TTL_S = 120 * 24 * 3600;
const MAX_COUNT = 1_000_000;

export const labels: Handler = async (ctx) => {
  const body = obj(ctx.body, "body");
  for (const k of Object.keys(body)) if (k !== "day" && k !== "counts") throw badRequest(k);
  const day = str(body, "day", "day");
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw badRequest("day");
  const counts = obj(body.counts, "counts");
  const add: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (!(LABEL_KEYS as readonly string[]).includes(k)) throw badRequest(`counts.${k}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_COUNT) throw badRequest(`counts.${k}`);
    add[k] = v;
  }

  await ctx.charge("labels", "daily");

  // A9: merge by addition into labels:<hash>:<day>, using the day the page reports.
  const key = `labels:${ctx.tester.hash}:${day}`;
  const prev = (await ctx.env.COS_KV.get<Record<string, number>>(key, "json")) ?? {};
  const merged: Record<string, number> = {};
  for (const k of LABEL_KEYS) {
    const sum = (typeof prev[k] === "number" ? prev[k] : 0) + (add[k] ?? 0);
    // Keep fractional sums (edit_ratio_sum) tidy.
    merged[k] = Math.round(sum * 1e6) / 1e6;
  }
  await ctx.env.COS_KV.put(key, JSON.stringify(merged), { expirationTtl: LABELS_TTL_S });
  return { ok: true };
};
