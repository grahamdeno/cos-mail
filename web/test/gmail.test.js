import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowed, buildRaw, createGmail, GmailAuthError, parseAddress, parseMessage, pickRecipient, splitAddresses } from "../public/js/gmail.js";
import { fakeFetch, gmailMsg } from "./helpers.js";

const decodeRaw = (raw) => Buffer.from(raw, "base64url").toString("utf8");

test("Gmail guard: reads, create draft and update draft only", () => {
  assert.doesNotThrow(() => assertAllowed("GET", "/threads?q=x"));
  assert.doesNotThrow(() => assertAllowed("POST", "/drafts"));
  assert.doesNotThrow(() => assertAllowed("PUT", "/drafts/r-123_abc"));
  const sendish = "/messages/" + "send";
  const draftSend = "/drafts/" + "send";
  for (const [m, p] of [["POST", sendish], ["POST", draftSend], ["DELETE", "/drafts/r1"], ["POST", "/messages/abc/trash"], ["POST", "/threads/abc/modify"], ["POST", "/messages/batchDelete"], ["PUT", "/drafts/a/b"], ["POST", "/drafts/r1"], ["PATCH", "/drafts"]]) {
    assert.throws(() => assertAllowed(m, p), /blocked Gmail call/, `${m} ${p}`);
  }
});

test("a full read-and-draft session makes only GETs, one POST /drafts and PUT /drafts/id", async () => {
  const f = fakeFetch([
    [(c) => c.url.includes("/threads?"), () => ({ threads: [{ id: "t1" }] })],
    [(c) => c.url.includes("/threads/t1"), () => ({ id: "t1", messages: [gmailMsg({ id: "m1", from: "Dana Lee <dana@example.com>", text: "Can you move Nov 9 to Nov 16?" })] })],
    [(c) => c.url.includes("/messages?"), () => ({ messages: [] })],
    [(c) => c.method === "POST" && c.url.endsWith("/drafts"), () => ({ id: "r1" })],
    [(c) => c.method === "PUT" && c.url.endsWith("/drafts/r1"), () => ({ id: "r1" })],
  ]);
  const g = createGmail({ getToken: () => "ACCESS", fetchImpl: f });
  const ids = await g.listThreadIds({ q: "x", max: 10 });
  await g.getThreads(ids);
  await g.getSentTo("dana@example.com");
  const raw = buildRaw({ to: "dana@example.com", subject: "Re: Install", body: "Yes." });
  assert.equal(await g.createDraft({ threadId: "t1", raw }), "r1");
  assert.equal(await g.updateDraft("r1", { threadId: "t1", raw }), "r1");
  for (const c of f.calls) {
    const path = new URL(c.url).pathname;
    const ok = c.method === "GET" || (c.method === "POST" && path.endsWith("/drafts")) || (c.method === "PUT" && /\/drafts\/r1$/.test(path));
    assert.ok(ok, `${c.method} ${path}`);
    assert.ok(!/\/send\b/.test(path));
    assert.equal(c.headers.Authorization, "Bearer ACCESS");
  }
});

test("no token means a clear error; 401 means ask again; 429 is retried", async () => {
  const g0 = createGmail({ getToken: () => null, fetchImpl: fakeFetch([]) });
  await assert.rejects(g0.getProfileEmail(), GmailAuthError);
  const g1 = createGmail({ getToken: () => "t", fetchImpl: fakeFetch([[() => true, () => ({ status: 401, body: {} })]]) });
  await assert.rejects(g1.getProfileEmail(), GmailAuthError);
  let n = 0;
  const g2 = createGmail({ getToken: () => "t", sleepImpl: async () => {}, fetchImpl: fakeFetch([[() => true, () => (++n < 3 ? { status: 429, body: {} } : { emailAddress: "Me@Example.com" })]]) });
  assert.equal(await g2.getProfileEmail(), "me@example.com");
  assert.equal(n, 3);
});

test("raw MIME: headers, threading, base64 body, non-ASCII subject, no header injection", () => {
  const raw = buildRaw({ to: "Dana <dana@example.com>\r\nBcc: evil@example.com", subject: "Re: Café\r\nX-Evil: 1", body: "Line one\nLine two é", inReplyTo: "<m1@mail.example.com>", references: "<m0@x> <m1@mail.example.com>" });
  const text = decodeRaw(raw);
  const [head, ...rest] = text.split("\r\n\r\n");
  assert.ok(!/^Bcc:/mi.test(head));
  assert.ok(!/^X-Evil:/mi.test(head));
  assert.match(head, /^To: Dana <dana@example.com> Bcc: evil@example.com$/m);
  assert.match(head, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  assert.match(head, /^In-Reply-To: <m1@mail.example.com>$/m);
  assert.match(head, /^References: <m0@x> <m1@mail.example.com>$/m);
  assert.match(head, /Content-Transfer-Encoding: base64/);
  const body = Buffer.from(rest.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(body, "Line one\r\nLine two é");
  assert.ok(!raw.includes("+") && !raw.includes("/") && !raw.includes("="), "base64url");
});

test("address parsing", () => {
  assert.deepEqual(splitAddresses('"Lee, Dana" <d@x.com>, "A, B" <ab@x.com>, c@x.com'), ['"Lee, Dana" <d@x.com>', '"A, B" <ab@x.com>', "c@x.com"]);
  assert.deepEqual(parseAddress('"Dana Lee" <Dana@Example.com>'), { name: "Dana Lee", email: "dana@example.com" });
  assert.deepEqual(parseAddress("bare@x.com"), { name: "", email: "bare@x.com" });
});

test("message parsing: plain preferred, HTML fallback, bodies trimmed", () => {
  const plain = parseMessage(gmailMsg({ id: "m1", from: "Dana Lee <dana@example.com>", text: "I'll call Monday.\n\n> old\n-- \nDana", html: "<p>ignored</p>" }));
  assert.equal(plain.body, "I'll call Monday.");
  assert.equal(plain.fromEmail, "dana@example.com");
  assert.equal(plain.fromName, "Dana Lee");
  assert.equal(plain.thread_id, "t1");
  const html = parseMessage(gmailMsg({ id: "m2", from: "x@example.com", text: null, html: "<div>Hello<br>there</div>" }));
  assert.equal(html.body, "Hello\nthere");
  const empty = parseMessage(gmailMsg({ id: "m3", from: "x@example.com", text: "> only quoted" }));
  assert.equal(empty.body, "(no text)");
});

test("reply goes to the last person who wrote to the tester, honoring Reply-To", () => {
  const msgs = [
    parseMessage(gmailMsg({ id: "a", from: "Dana <dana@example.com>", text: "Q?" })),
    parseMessage(gmailMsg({ id: "b", from: "Me <me@example.com>", to: "dana@example.com", text: "A." })),
    parseMessage(gmailMsg({ id: "c", from: "Dana <dana@example.com>", text: "Thanks", extra: [{ name: "Reply-To", value: "Dana Work <dana.work@example.com>" }] })),
  ];
  assert.equal(pickRecipient(msgs, "me@example.com").email, "dana.work@example.com");
  const mine = [msgs[1]];
  assert.equal(pickRecipient(mine, "me@example.com").email, "dana@example.com");
});
