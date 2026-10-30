// Fixed settings. Nothing here is a secret: the client ID is public by design.
export const CONFIG = Object.freeze({
  clientId: "456735134102-53s6afv6b316sj1bes9phmb71rc78mi5.apps.googleusercontent.com",
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "openid",
    "email",
  ].join(" "),
  dayTz: "America/New_York",
  dayStartHour: 4,
  undoMs: 5000,
  swipePx: 90,
  tapSlopPx: 8,
  maxDecisions: 5,
  bodyMax: 1500,
  sortPerCall: 50,
  extractPerCall: 20,
  maxBatchChars: 300000, // the Worker rejects bodies over 400 KB
  threadMsgMax: 15,
  draftMsgMax: 8,
  styleExamples: 5,
  retainDays: 30,
  unchangedForLevel3: 50,
  backfill: { days: 30, maxThreads: 150, sortCalls: 12, extractCalls: 8 },
  daily: { maxThreads: 60, sortCalls: 4, extractCalls: 2 },
});

/** The Worker lives under /api on the same domain. On localhost, call the live Worker (CORS allows localhost). */
export function apiBase(loc = globalThis.location) {
  return loc && loc.hostname === "localhost" ? "https://cos.tangomike.app/api" : "/api";
}
