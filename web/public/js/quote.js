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
