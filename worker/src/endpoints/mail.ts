import { badRequest } from "../errors";
import { BODY_MAX, ID_MAX, SHORT_MAX, obj, optStr, str, strArray } from "../validate";

export interface MailMessage {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  body: string;
}

/** A thread or sort message. `to`/`cc` default to [] where the contract omits them (A8, A10). */
export function parseMessage(v: unknown, field: string, opts: { requireTo: boolean }): MailMessage {
  const o = obj(v, field);
  const id = str(o, "id", `${field}.id`, { nonEmpty: true, max: ID_MAX });
  const from = str(o, "from", `${field}.from`, { max: SHORT_MAX });
  const to = strArray(o, "to", `${field}.to`, { optional: !opts.requireTo, maxItems: 100 });
  const cc = strArray(o, "cc", `${field}.cc`, { optional: true, maxItems: 100 });
  const date = str(o, "date", `${field}.date`, { max: 64 });
  const body = str(o, "body", `${field}.body`, { max: BODY_MAX, limitIs413: true });
  return { id, from, to, cc, date, body };
}

export function parseMode(o: Record<string, unknown>): "daily" | "backfill" {
  const v = o.mode;
  if (v === undefined) return "daily";
  if (v !== "daily" && v !== "backfill") throw badRequest("mode");
  return v;
}

export function optSubject(o: Record<string, unknown>, field: string): string {
  return optStr(o, "subject", field, { max: SHORT_MAX }) ?? "";
}
