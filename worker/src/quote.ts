/** Normalize for the quote check: collapse all whitespace and ignore case. */
export function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
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
