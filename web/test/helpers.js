// Shared test helpers. Everything here is synthetic: no real mail, names or tokens.
export const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

/** A Gmail API message (format=full) with a plain-text body. */
export function gmailMsg({ id, threadId = "t1", from, to = "me@example.com", subject = "Hello", text = "", html = null, internalDate = Date.parse("2026-10-28T14:00:00Z"), labelIds = ["INBOX"], extra = [] }) {
  const headers = [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Subject", value: subject },
    { name: "Message-ID", value: `<${id}@mail.example.com>` },
    ...extra,
  ];
  const parts = [];
  if (text !== null) parts.push({ mimeType: "text/plain", body: { data: b64url(text) } });
  if (html) parts.push({ mimeType: "text/html", body: { data: b64url(html) } });
  return { id, threadId, internalDate: String(internalDate), labelIds, payload: { mimeType: "multipart/alternative", headers, parts } };
}

/** A fake fetch that records every call. `routes` is an array of [matcher, handler]. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? null };
    calls.push(call);
    for (const [match, handler] of routes) {
      if (match(call)) {
        const out = await handler(call);
        return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

/** A manual clock for the undo window. */
export function fakeTimers() {
  let now = 0, id = 0;
  const q = new Map();
  return {
    setT: (f, t) => { q.set(++id, { f, at: now + t }); return id; },
    clearT: (i) => q.delete(i),
    advance(ms) {
      now += ms;
      for (const [i, t] of [...q]) if (t.at <= now) { q.delete(i); t.f(); }
    },
    get pending() { return q.size; },
  };
}
