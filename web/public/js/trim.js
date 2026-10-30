// Trim a message body before it leaves the phone: drop quoted replies and signatures, cap the length.
import { CONFIG } from "./config.js";

const MOBILE_SIG = /^(sent from my (iphone|ipad|android|galaxy|phone|mobile|samsung)|sent from mail for windows|sent from outlook for|get outlook for|sent with proton ?mail|sent via )/i;
const HEADER_BLOCK = /^(from|de|von):\s+\S/i;
const HEADER_FOLLOW = /^(sent|date|to|subject|envoy[eé]|a|an|cc):\s*/i;

export function stripQuoted(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith(">")) continue;
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(t)) break;
    if (/^_{8,}$/.test(t)) break; // Outlook divider
    if (t === "--" || t === "-- ") break; // signature delimiter
    if (MOBILE_SIG.test(t)) break;
    if (/^On\s/.test(t) && t.length < 250) {
      // "On <date>, <name> wrote:" often wraps onto the next one or two lines.
      const joined = [t, lines[i + 1] ?? "", lines[i + 2] ?? ""].map((x) => x.trim()).join(" ").replace(/\s+/g, " ");
      if (/^On\s.{5,300}?\swrote:/.test(joined)) break;
    }
    if (HEADER_BLOCK.test(t)) {
      // An Outlook-style header block: From: ... then Sent:/Date:/To:/Subject: within a few lines.
      const next = lines.slice(i + 1, i + 5).map((l) => l.trim());
      if (next.some((l) => HEADER_FOLLOW.test(l))) break;
    }
    out.push(lines[i]);
  }
  return out.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip quotes and signatures, then keep at most `max` characters. */
export function trimBody(text, max = CONFIG.bodyMax) {
  let s = stripQuoted(text);
  if (s.length > max) {
    s = s.slice(0, max);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // do not end on half a surrogate pair
  }
  return s.trimEnd();
}

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

/** Plain-text view of an HTML mail body. No DOM needed; quoted blocks are removed first. */
export function htmlToText(html) {
  let s = String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<div[^>]*class="[^"]*gmail_quote[\s\S]*$/i, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- Step 4: keys and tokens never leave the phone. ----
// Patterns are assembled from parts so this file does not itself look like it holds a key.
const KEY_PATTERNS = [
  ["sk-" + "ant-", "[A-Za-z0-9_-]{10,}"],
  ["sk-", "(?:proj-)?[A-Za-z0-9_-]{32,}"],
  ["pplx-", "[A-Za-z0-9]{20,}"],
  ["gh" + "[pousr]_", "[A-Za-z0-9]{20,}"],
  ["github_" + "pat_", "[A-Za-z0-9_]{20,}"],
  ["AI" + "za", "[0-9A-Za-z_-]{30,}"],
  ["ya" + "29\\.", "[A-Za-z0-9_-]{20,}"],
  ["1//" + "0", "[A-Za-z0-9_-]{20,}"],
  ["GOC" + "SPX-", "[A-Za-z0-9_-]{10,}"],
  ["xox" + "[abprs]-", "[A-Za-z0-9-]{10,}"],
  ["AK" + "IA", "[0-9A-Z]{16}"],
  ["eyJ", "[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"],
].map(([a, b]) => new RegExp(`(?<![A-Za-z0-9_-])${a}${b}`, "g"));
const PRIVATE_KEY = new RegExp("-----BEGIN [A-Z ]*PRIV" + "ATE KEY-----[\\s\\S]*?(-----END [A-Z ]*PRIV" + "ATE KEY-----|$)", "g");

/** Replace anything shaped like an API key, token or private key with a marker. */
export function redactSecrets(text) {
  let s = String(text).replace(PRIVATE_KEY, "[key removed]");
  for (const re of KEY_PATTERNS) s = s.replace(re, "[key removed]");
  return s;
}
