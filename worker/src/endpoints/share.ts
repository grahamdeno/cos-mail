import { isoSeconds } from "../day";
import { randomHex } from "../hash";
import { ID_MAX, arr, isObj, obj, oneOf, optStr, str } from "../validate";
import { badRequest } from "../errors";
import type { Handler } from "./context";
import { optSubject, parseMessage } from "./mail";

export const SHARE_LABELS = ["not_a_promise", "needed_me", "missed_one", "draft_edited"] as const;
const SMALL_JSON_MAX = 8000;

function smallJson(v: unknown, field: string): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    if (v.length > 1500) throw badRequest(field);
    return v;
  }
  if (!isObj(v)) throw badRequest(field);
  if (JSON.stringify(v).length > SMALL_JSON_MAX) throw badRequest(field);
  return v;
}

/**
 * A10: only sent after a tester taps Share on one item. Stored under
 * share:<ISO time>:<6 random hex> with the tester's hash, never their email.
 */
export const share: Handler = async (ctx) => {
  const body = obj(ctx.body, "body");
  const label = oneOf(body, "label", "label", SHARE_LABELS);
  const note = optStr(body, "note", "note", { max: 500, limitIs413: true });
  const ex = obj(body.example, "example");
  const example = {
    thread_id: str(ex, "thread_id", "example.thread_id", { nonEmpty: true, max: ID_MAX }),
    subject: optSubject(ex, "example.subject"),
    messages: arr(ex, "messages", "example.messages", { min: 1, max: 15 }).map((m, i) =>
      parseMessage(m, `example.messages[${i}]`, { requireTo: false }),
    ),
    model_output: smallJson(ex.model_output, "example.model_output"),
    correction: smallJson(ex.correction, "example.correction"),
  };

  await ctx.charge("share", "daily");

  const at = isoSeconds(ctx.nowMs);
  const id = `share:${at}:${randomHex(3)}`;
  await ctx.env.COS_KV.put(id, JSON.stringify({ label, note, example, tester: ctx.tester.hash, at }));
  return { ok: true, id };
};
