// The quote check. Must match worker/src/quote.ts (a test compares them on the same inputs).

export function normalize(s) {
  return s
    .replace(/[’‘‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—‒−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when `quote` appears in `body` after normalizing whitespace, punctuation style and case. */
export function quoteInBody(quote, body) {
  if (body === undefined || body === null) return false;
  const q = normalize(quote);
  if (q === "") return false;
  return normalize(body).includes(q);
}

// ---- Step 4: the same item check the Worker runs (worker/src/quote.ts checkQuote). A test keeps them equal. ----

export const QUOTE_MIN_CHARS = 8;
export const QUOTE_MIN_WORDS = 2;

/** The address in a From header: the part in <angle brackets>, or the whole value, lowercased. */
export function emailOf(from) {
  const m = /<([^<>]+)>\s*$/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

/**
 * null when the item may be shown; otherwise why it is dropped.
 * kind: "i_owe" (quote must be the tester's words), "owed_to_me" or "decision" (someone else's words).
 * messages: Map of message id to { thread_id, from, body } exactly as sent to the Worker.
 */
export function checkQuote(item, kind, messages, testerEmail) {
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
