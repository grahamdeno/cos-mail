import { dayKey, isoSeconds, nextReset } from "./day";
import type { Env } from "./env";
import { HttpError } from "./errors";

export type Counter = "sort" | "extract" | "draft" | "share" | "labels";
export type Mode = "daily" | "backfill";

/** A4.5 caps table. The owner has the same caps. */
export const CAPS: Record<Mode, Record<Counter, number>> = {
  daily: { sort: 4, extract: 2, draft: 20, share: 10, labels: 4 },
  backfill: { sort: 12, extract: 8, draft: 20, share: 10, labels: 4 },
};

const NOUN: Record<Counter, [string, string]> = {
  sort: ["sort", "sorts"],
  extract: ["brief", "briefs"],
  draft: ["draft", "drafts"],
  share: ["shared example", "shared examples"],
  labels: ["label upload", "label uploads"],
};

export const BYTES_MAX = 400 * 1024;
export const USAGE_TTL_S = 3 * 24 * 3600;
export const BACKFILL_TTL_S = 7 * 24 * 3600;

type UsageRecord = Record<Counter, number>;

const emptyUsage = (): UsageRecord => ({ sort: 0, extract: 0, draft: 0, share: 0, labels: 0 });

export interface CapContext {
  day: string;
  resetsAt: string;
}

function dayConfig(env: Env, nowMs: number): { tz: string; hour: number } {
  const hour = Number.parseInt(env.DAY_START_HOUR, 10);
  return { tz: env.DAY_TZ || "America/New_York", hour: Number.isFinite(hour) ? hour : 4 };
}

export function currentDay(env: Env, nowMs: number): string {
  const { tz, hour } = dayConfig(env, nowMs);
  return dayKey(nowMs, tz, hour);
}

/**
 * Check and count one call against the tester's daily cap (A4.5).
 *
 * Backfill: a request with mode "backfill" starts the backfill window if
 * `backfill:<hash>` does not exist, writing it with a 7-day TTL. Backfill-mode
 * requests on the same day the backfill started continue that run (a 30-day
 * backfill needs several sort and extract calls); on any later day while the
 * key exists they get 429 backfill_used. On the backfill day, all of the
 * tester's calls use the backfill caps.
 *
 * The call is counted before the model is called, because a failed model call
 * still spends tokens.
 */
export async function chargeCap(
  env: Env,
  hash: string,
  counter: Counter,
  requestedMode: Mode,
  nowMs: number,
): Promise<CapContext> {
  const { tz, hour } = dayConfig(env, nowMs);
  const day = dayKey(nowMs, tz, hour);
  const resetsAt = nextReset(nowMs, tz, hour);

  const backfillKey = `backfill:${hash}`;
  const backfill = await env.COS_KV.get<{ at?: string }>(backfillKey, "json");
  const backfillAtMs = backfill?.at ? Date.parse(backfill.at) : NaN;
  const backfillDay = Number.isFinite(backfillAtMs) ? dayKey(backfillAtMs, tz, hour) : null;
  const backfillToday = backfill !== null && backfillDay === day;

  if (requestedMode === "backfill" && backfill !== null && !backfillToday) {
    const again = Number.isFinite(backfillAtMs) ? isoSeconds(backfillAtMs + BACKFILL_TTL_S * 1000) : resetsAt;
    throw new HttpError("backfill_used", { resetsAt: again });
  }

  const mode: Mode = requestedMode === "backfill" || backfillToday ? "backfill" : "daily";
  const cap = CAPS[mode][counter];

  const usageKey = `usage:${hash}:${day}`;
  const usage = { ...emptyUsage(), ...((await env.COS_KV.get<Partial<UsageRecord>>(usageKey, "json")) ?? {}) };
  if (usage[counter] >= cap) {
    const [one, many] = NOUN[counter];
    throw new HttpError("daily_limit", {
      message: `You've used today's ${cap} ${cap === 1 ? one : many}. More tomorrow after 4 AM.`,
      resetsAt,
    });
  }

  if (requestedMode === "backfill" && backfill === null) {
    await env.COS_KV.put(backfillKey, JSON.stringify({ at: isoSeconds(nowMs) }), { expirationTtl: BACKFILL_TTL_S });
  }
  usage[counter] += 1;
  await env.COS_KV.put(usageKey, JSON.stringify(usage), { expirationTtl: USAGE_TTL_S });
  return { day, resetsAt };
}
