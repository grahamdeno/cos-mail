/**
 * Day boundaries (A3): a day is the calendar date in DAY_TZ after subtracting
 * DAY_START_HOUR hours, so with America/New_York and 4 a day starts at 4 AM Eastern.
 */

/** Wall-clock time in `tz` at instant `ms`, expressed as if it were UTC milliseconds. */
function wallClockMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (EDT is -4h). */
function offsetMs(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallClockMs(whole, tz) - whole;
}

export function dayKey(nowMs: number, tz: string, startHour: number): string {
  const shifted = wallClockMs(nowMs, tz) - startHour * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** The next day start (e.g. 4 AM America/New_York) after `nowMs`, as a UTC ISO string without milliseconds. */
export function nextReset(nowMs: number, tz: string, startHour: number): string {
  const today = dayKey(nowMs, tz, startHour);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  // Local wall-clock target: tomorrow at startHour:00 in tz.
  const localTarget = Date.UTC(y, m - 1, d + 1, startHour, 0, 0);
  // Convert local wall-clock to UTC, refining once for DST transitions.
  let utc = localTarget - offsetMs(localTarget, tz);
  utc = localTarget - offsetMs(utc, tz);
  return isoSeconds(utc);
}

export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
