/**
 * Normalize for the quote check: map typographic punctuation to plain ASCII,
 * drop zero-width characters, then collapse all whitespace and ignore case.
 */
export function normalize(s: string): string {
  return s
    .replace(/[\u2019\u2018\u201B\u2032]/g, "'") // ’ ‘ ‛ ′
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"') // “ ” „ ″
    .replace(/[\u2013\u2014\u2012\u2212]/g, "-") // – — ‒ −
    .replace(/\u2026/g, "...") // …
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "") // zero-width space, non-joiner, joiner, BOM
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when `quote` appears in `body` after normalizing whitespace and case. */
export function quoteInBody(quote: string, body: string | undefined): boolean {
  if (body === undefined) return false;
  const q = normalize(quote);
  if (q === "") return false;
  return normalize(body).includes(q);
}

/** A8: the `[bracketed]` gaps a draft left for facts the model did not have. */
export function findBlanks(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\[[^\[\]\n]{1,80}\]/g)) seen.add(m[0]);
  return [...seen];
}

/** The address in a From header: the part in <angle brackets>, or the whole value, lowercased. */
export function emailOf(from: string): string {
  const m = /<([^<>]+)>\s*$/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

export type DropReason = "quote_not_found" | "quote_too_short" | "wrong_speaker" | "wrong_thread";

export interface QuotedMessage {
  thread_id: string;
  from: string;
  body: string;
}

/** At least two words and eight characters after normalizing, so a quote cannot be a lone "yes" or "Monday". */
export const QUOTE_MIN_CHARS = 8;
export const QUOTE_MIN_WORDS = 2;

/**
 * Step 4 quote check. An item survives only if its quote:
 *  - comes from a message in the same thread (wrong_thread),
 *  - is long enough to mean something (quote_too_short),
 *  - appears in that message's body after normalizing (quote_not_found),
 *  - was written by the right person (wrong_speaker): the tester for i_owe; someone else for owed_to_me and decisions.
 */
export function checkQuote(
  item: { thread_id: string; quote: string; quote_message_id: string },
  kind: "i_owe" | "owed_to_me" | "decision",
  messages: Map<string, QuotedMessage>,
  testerEmail: string,
): DropReason | null {
  const msg = messages.get(item.quote_message_id);
  if (!msg) return "quote_not_found";
  if (msg.thread_id !== item.thread_id) return "wrong_thread";
  const q = normalize(item.quote);
  if (q.length < QUOTE_MIN_CHARS || q.split(" ").length < QUOTE_MIN_WORDS) return "quote_too_short";
  if (!normalize(msg.body).includes(q)) return "quote_not_found";
  const byTester = emailOf(msg.from) === testerEmail.trim().toLowerCase();
  if (kind === "i_owe" ? !byTester : byTester) return "wrong_speaker";
  return null;
}
