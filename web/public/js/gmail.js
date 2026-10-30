// Gmail from the page, with the tester's own one-hour access token.
// The only writes this file can make are: create a draft, and update a draft this app made.
// It cannot send, delete, trash, archive or label. The guard below enforces that.
import { CONFIG } from "./config.js";
import { htmlToText, redactSecrets, trimBody } from "./trim.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailAuthError extends Error {
  constructor() { super("Google access ended. Tap Get my brief to continue."); this.name = "GmailAuthError"; }
}

/** Defense in depth: reads, creating a draft, and updating a draft. Nothing else leaves this file. */
export function assertAllowed(method, path) {
  const ok =
    method === "GET" ||
    (method === "POST" && path === "/drafts") ||
    (method === "PUT" && /^\/drafts\/[A-Za-z0-9_-]+$/.test(path));
  if (!ok) throw new Error(`blocked Gmail call: ${method} ${path}`);
}

// ---------- parsing ----------

export function b64urlToText(data) {
  const b64 = String(data).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(data.length / 4) * 4, "=");
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function findPart(payload, mime) {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body?.data) return payload.body.data;
  for (const p of payload.parts ?? []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return null;
}

/** Split "A <a@x.com>, \"B, C\" <b@x.com>" on commas that are outside quotes and angle brackets. */
export function splitAddresses(s) {
  const out = [];
  let cur = "", quoted = false, angle = false;
  for (const ch of s ?? "") {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if (ch === "," && !quoted && !angle) { if (cur.trim()) out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseAddress(s) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s ?? "");
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const bare = (s ?? "").trim();
  return { name: "", email: bare.toLowerCase() };
}

/** One Gmail API message (format=full) to the shape the rest of the app uses. Bodies are trimmed here. */
export function parseMessage(m) {
  const headers = new Map((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  const h = (n) => headers.get(n) ?? "";
  const plain = findPart(m.payload, "text/plain");
  const html = plain ? null : findPart(m.payload, "text/html");
  const raw = plain ? b64urlToText(plain) : html ? htmlToText(b64urlToText(html)) : "";
  const from = parseAddress(h("from"));
  const internalMs = Number(m.internalDate) || Date.parse(h("date")) || 0;
  return {
    id: m.id,
    thread_id: m.threadId,
    from: h("from"),
    fromEmail: from.email,
    fromName: from.name || from.email,
    to: splitAddresses(h("to")),
    cc: splitAddresses(h("cc")),
    replyTo: h("reply-to"),
    date: new Date(internalMs).toISOString(),
    internalMs,
    subject: redactSecrets(h("subject")),
    labels: m.labelIds ?? [],
    body: redactSecrets(trimBody(raw)) || "(no text)",
    messageIdHeader: h("message-id"),
    references: h("references"),
  };
}

// ---------- drafts ----------

const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim(); // no header injection

function encodeSubject(s) {
  const v = clean(s);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${bytesToB64(new TextEncoder().encode(v))}?=`;
}

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** An RFC 2822 reply as base64url, ready for drafts.create. */
export function buildRaw({ to, subject, body, inReplyTo, references }) {
  const lines = [`To: ${clean(to)}`, `Subject: ${encodeSubject(subject)}`];
  if (inReplyTo) lines.push(`In-Reply-To: ${clean(inReplyTo)}`);
  if (references) lines.push(`References: ${clean(references)}`);
  const b64 = bytesToB64(new TextEncoder().encode(String(body).replace(/\r?\n/g, "\r\n")));
  lines.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64.replace(/.{1,76}/g, "$&\r\n").trimEnd());
  return bytesToB64(new TextEncoder().encode(lines.join("\r\n"))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Who a reply goes to: the last person who wrote to the tester; if the tester wrote last, that message's first recipient. */
export function pickRecipient(messages, meEmail) {
  const me = meEmail.toLowerCase();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.fromEmail !== me) {
      const target = parseAddress(m.replyTo || m.from);
      return { name: target.name || m.fromName, email: target.email || m.fromEmail, message: m };
    }
  }
  const last = messages[messages.length - 1];
  const first = parseAddress(last?.to?.[0] ?? "");
  return { name: first.name || first.email, email: first.email, message: last };
}

// ---------- client ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export function createGmail({ getToken, fetchImpl = (url, init) => fetch(url, init), sleepImpl = sleep }) {
  async function call(method, path, body) {
    assertAllowed(method, path);
    for (let attempt = 0; ; attempt++) {
      const token = getToken();
      if (!token) throw new GmailAuthError();
      const res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.json();
      if (res.status === 401) throw new GmailAuthError();
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleepImpl(500 * 2 ** attempt); continue; }
      throw new Error(`Gmail said no (${res.status}). Try again in a minute.`);
    }
  }

  const getMessage = async (id) => parseMessage(await call("GET", `/messages/${encodeURIComponent(id)}?format=full`));

  return {
    async getProfileEmail() { return String((await call("GET", "/profile")).emailAddress).toLowerCase(); },

    async listThreadIds({ q, max }) {
      const ids = [];
      let pageToken = "";
      while (ids.length < max) {
        const qs = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) });
        if (pageToken) qs.set("pageToken", pageToken);
        const r = await call("GET", `/threads?${qs}`);
        for (const t of r.threads ?? []) ids.push(t.id);
        pageToken = r.nextPageToken;
        if (!pageToken) break;
      }
      return ids.slice(0, max);
    },

    async getThread(id) {
      const t = await call("GET", `/threads/${encodeURIComponent(id)}?format=full`);
      const messages = (t.messages ?? []).map(parseMessage).sort((a, b) => a.internalMs - b.internalMs);
      return { thread_id: t.id, subject: messages[0]?.subject ?? "", messages };
    },

    /** @param {string[]} ids @param {(n: number) => void} [onProgress] */
    async getThreads(ids, onProgress = () => {}) {
      let done = 0;
      const out = await pool(ids, 6, async (id) => {
        try { return await this.getThread(id); } finally { onProgress(++done); }
      });
      return out.filter((t) => t.messages.length);
    },

    /** The tester's recent sent mail to one person, for writing in their voice. */
    async getSentTo(email, n = CONFIG.styleExamples) {
      const qs = new URLSearchParams({ q: `in:sent to:${email}`, maxResults: String(n) });
      const r = await call("GET", `/messages?${qs}`);
      return pool(r.messages ?? [], 3, (m) => getMessage(m.id));
    },

    createDraft: async ({ threadId, raw }) => (await call("POST", "/drafts", { message: { raw, threadId } })).id,
    updateDraft: async (id, { threadId, raw }) => (await call("PUT", `/drafts/${encodeURIComponent(id)}`, { message: { raw, threadId } })).id,
  };
}
