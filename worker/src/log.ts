/**
 * A12: one line per request, nothing else. The line carries only these keys.
 * Never pass bodies, subjects, emails, tokens or model output here.
 */
export interface LogLine {
  t: string;
  tester: string | null;
  endpoint: string;
  model: string | null;
  in: number;
  out: number;
  status: number;
  ms: number;
}

export const LOG_KEYS = ["t", "tester", "endpoint", "model", "in", "out", "status", "ms"] as const;

export function logRequest(line: LogLine): void {
  // Build the object field by field so nothing else can ride along.
  const safe: LogLine = {
    t: line.t,
    tester: typeof line.tester === "string" && /^[0-9a-f]{16}$/.test(line.tester) ? line.tester : null,
    endpoint: line.endpoint,
    model: line.model,
    in: Number.isFinite(line.in) ? line.in : 0,
    out: Number.isFinite(line.out) ? line.out : 0,
    status: line.status,
    ms: Math.max(0, Math.round(line.ms)),
  };
  console.log(JSON.stringify(safe));
}
