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
