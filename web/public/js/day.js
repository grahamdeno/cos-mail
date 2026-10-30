// Day boundaries, matching the Worker: the calendar date in DAY_TZ after subtracting DAY_START_HOUR hours.

function wallClockMs(ms, tz) {
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
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** @param {number} nowMs @param {string} tz @param {number} startHour */
export function dayKey(nowMs, tz, startHour) {
  const shifted = wallClockMs(nowMs, tz) - startHour * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** The day after a YYYY-MM-DD key. */
export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a, b) {
  const t = (s) => Date.parse(`${s}T00:00:00Z`);
  return Math.round((t(b) - t(a)) / 86_400_000);
}
