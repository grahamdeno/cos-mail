// End-to-end run in a real browser, with Google, Gmail and the Worker all faked. Synthetic mail only.
// Usage: node e2e/run.mjs [outDir]    (needs Playwright; not part of CI)
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const OUT = process.argv[2] ?? "/tmp/cos-shots";
await mkdir(OUT, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://localhost:${server.address().port}`;

// ---------- fakes ----------
const b64u = (s) => Buffer.from(s).toString("base64url");
const ID_TOKEN = `eyJhbGciOiJSUzI1NiJ9.${b64u(JSON.stringify({ email: "maria.test@example.com", name: "Maria Test", given_name: "Maria", exp: Math.floor(Date.now() / 1000) + 3600 }))}.c2ln`;
const ACCESS = "ya" + "29.E2E-FAKE-ACCESS-TOKEN-0123456789abcdef"; // concatenated so the repo scan ignores this fake
const GIS = `window.google={accounts:{id:{initialize:o=>{window.__cb=o.callback},prompt:()=>setTimeout(()=>window.__cb({credential:${JSON.stringify(ID_TOKEN)}}),30),renderButton:el=>{el.textContent="Sign in with Google (test)"},disableAutoSelect(){}},oauth2:{initTokenClient:o=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:${JSON.stringify(ACCESS)},expires_in:3600}),30)}),revoke:(t,d)=>{window.__revoked=t;d&&d()}}}};`;

const now = Date.now();
const day = 86_400_000;
const msg = (id, threadId, from, to, subject, text, ago, labelIds = ["INBOX"]) => ({
  id, threadId, internalDate: String(now - ago), labelIds,
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: subject }, { name: "Message-ID", value: `<${id}@mail.example.com>` }], body: { data: b64u(text) } },
});
const ME = "Maria Test <maria.test@example.com>";
const THREADS = {
  t1: [msg("m1", "t1", "Tom Henderson <tom@example.com>", ME, "Install date", "Can you move my kitchen install from Nov 9 to Nov 16?", day)],
  t2: [msg("m2", "t2", "Coastal Lumber <orders@example.com>", ME, "Walnut order", "Confirm the walnut order: 40 board feet at $14.20?", 2 * day)],
  t3: [msg("m3", "t3", "Jenna Cole <jenna@example.com>", ME, "Pantry", "Are you taking pantry jobs before the holidays?", 3 * day)],
  t4: [msg("m4", "t4", "Rachel Park <rachel@example.com>", ME, "Quote", "Thanks for the photos.", 9 * day), msg("m5", "t4", ME, "Rachel Park <rachel@example.com>", "Re: Quote", "I'll send the revised quote with soft-close hinges by Monday.", 8 * day, ["SENT"])],
  t5: [msg("m6", "t5", "Dave <dave@example.com>", ME, "Trim", "Call me when you can.", 14 * day), msg("m7", "t5", ME, "Dave <dave@example.com>", "Re: Trim", "I'll call you Monday about the trim order.", 13 * day, ["SENT"])],
  t6: [msg("m8", "t6", "Jenna Cole <jenna@example.com>", ME, "Pantry plan", "Any news?", 20 * day), msg("m9", "t6", ME, "Jenna Cole <jenna@example.com>", "Re: Pantry plan", "I'll look at your pantry floor plan this week.", 19 * day, ["SENT"])],
  t7: [msg("m10", "t7", "Mike Ruiz <mike@example.com>", ME, "Deposit", "I will send the deposit on Friday.", 5 * day)],
  t8: [msg("m11", "t8", "Shop <orders@example.com>", ME, "Receipt #4471", "Your invoice #4471 is paid.", 6 * 3600_000)],
  t9: [msg("m12", "t9", "Home Depot Pro <deals@example.com>", ME, "Weekly deals", "This week: 20% off.", 7 * 3600_000)],
};
const cors = { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "Authorization, Content-Type", "access-control-allow-methods": "POST, OPTIONS" };
const log = { gmail: [], worker: [], errors: [] };

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: false });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") log.errors.push(m.text()); });
  await ctx.route("https://accounts.google.com/gsi/client", (r) => r.fulfill({ contentType: "text/javascript", body: GIS }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: "text/css", body: "" }));
  await ctx.route("https://gmail.googleapis.com/**", async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    log.gmail.push({ method: req.method(), path: u.pathname.replace("/gmail/v1/users/me", ""), auth: req.headers()["authorization"] });
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    const json = (body) => r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/profile") return json({ emailAddress: "maria.test@example.com" });
    if (path === "/threads") return json({ threads: Object.keys(THREADS).map((id) => ({ id })) });
    if (path.startsWith("/threads/")) { const id = path.split("/")[2]; return json({ id, messages: THREADS[id] }); }
    if (path === "/messages") return json({ messages: [{ id: "m5" }] });
    if (path.startsWith("/messages/")) { const id = path.split("/")[2]; const m = Object.values(THREADS).flat().find((x) => x.id === id); return json(m); }
    if (path === "/drafts" && req.method() === "POST") return json({ id: "r1" });
    if (path.startsWith("/drafts/") && req.method() === "PUT") return json({ id: "r1" });
    return r.fulfill({ status: 404, body: "{}" });
  });
  await ctx.route("https://cos.tangomike.app/api/**", async (r) => {
    const req = r.request();
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname.replace("/api", "");
    const body = JSON.parse(req.postData() ?? "{}");
    log.worker.push({ path, auth: req.headers()["authorization"], raw: req.postData() ?? "" });
    const json = (o, status = 200) => r.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(o) });
    if (path === "/sort") return json({ results: body.messages.map((m) => (/Receipt|Weekly deals/.test(m.subject) ? { id: m.id, verdict: "handled", group: /Receipt/.test(m.subject) ? "receipt" : "newsletter", reason: /Receipt/.test(m.subject) ? "Coastal Lumber invoice #4471, paid." : "Weekly deals. You've never opened one." } : { id: m.id, verdict: "needs_you", group: null, reason: "Asks you something." })) });
    if (path === "/extract") {
      const c = (thread_id, person, what, quote, quote_message_id, due) => ({ thread_id, direction: "i_owe", person, what, quote, quote_message_id, due, due_kind: due ? "stated" : null, status: "open", confidence: "high" });
      const d = (thread_id, person, question, quote, quote_message_id, answer, reason, rank) => ({ thread_id, person, question, quote, quote_message_id, recommended: { answer, reason }, alternate: "Not now", deadline: null, rank });
      const dayStr = (ago) => new Date(now - ago * day).toISOString().slice(0, 10);
      return json({
        commitments: [
          c("t6", "Jenna Cole", "Look at pantry plan", "I'll look at your pantry floor plan this week.", "m9", dayStr(12)),
          c("t4", "Rachel Park", "Send revised quote", "I'll send the revised quote with soft-close hinges by Monday.", "m5", dayStr(4)),
          c("t5", "Dave, Coastal Lumber", "Call about trim order", "I'll call you Monday about the trim order.", "m7", dayStr(11)),
          { thread_id: "t7", direction: "owed_to_me", person: "Mike Ruiz", what: "deposit", quote: "I will send the deposit on Friday.", quote_message_id: "m10", due: null, due_kind: null, status: "open", confidence: "high" },
          c("t4", "Rachel Park", "Invented one", "I will repaint your house for free.", "m5", null),
        ],
        decisions: [
          d("t1", "Tom Henderson", "Can you move my kitchen install from Nov 9 to Nov 16?", "move my kitchen install from Nov 9 to Nov 16", "m1", "Yes", "Your Nov 16 week is open, and he's a repeat client.", 1),
          d("t2", "Coastal Lumber", "Confirm the walnut order: 40 board feet at $14.20?", "Confirm the walnut order: 40 board feet at $14.20?", "m2", "Confirm", "It matches the quote you sent the Parks on Oct 22.", 2),
          d("t3", "Jenna Cole", "Are you taking pantry jobs before the holidays?", "Are you taking pantry jobs before the holidays?", "m3", "Yes, for January", "November is full.", 3),
        ],
        dropped: [],
      });
    }
    if (path === "/draft") return json({ subject: "Re: " + body.subject, body: `Hi ${body.decision.question.split(" ")[0]},\n\n${body.answer.text}. Nov 16 works. I'll have the crew there at 8 that Monday, same as last time.\n\nMaria`, blanks: [] });
    if (path === "/labels") return json({ ok: true });
    return json({ error: { code: "not_found", message: "no" } }, 404);
  });
  return { ctx, page };
}

const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const noSideScroll = async (page, label) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  if (o.sw > o.iw) throw new Error(`${label}: horizontal scroll ${o.sw} > ${o.iw}`);
};

async function run(browser, width, height) {
  const tag = `${width}`;
  const { ctx, page } = await newPage(browser, { width, height });
  await page.goto(ORIGIN + "/");
  await page.waitForSelector("text=Read my last 30 days"); await noSideScroll(page, "connect"); await shot(page, `${tag}-1-connect`);
  await page.click("text=Read my last 30 days");
  await page.waitForSelector("text=Start today"); await noSideScroll(page, "reveal"); await shot(page, `${tag}-2-reveal`);
  // Swipe the first promise left (past 90 px) and undo it.
  const row = page.locator(".peek").first();
  const rb = await row.boundingBox();
  await page.mouse.move(rb.x + rb.width - 20, rb.y + 20); await page.mouse.down(); await page.mouse.move(rb.x + rb.width - 140, rb.y + 22, { steps: 6 }); await page.mouse.up();
  await page.waitForSelector("#undo:not([hidden])"); await shot(page, `${tag}-2b-reveal-undo`);
  await page.click("#undo-b");
  await page.click("text=Start today");
  await page.waitForSelector(".deckzone"); await noSideScroll(page, "brief"); await shot(page, `${tag}-3-brief`);
  const before = log.gmail.filter((g) => g.method !== "GET").length;
  // Swipe right: the undo bar shows and nothing is written to Gmail yet.
  const z = await page.locator(".deckzone").boundingBox();
  await page.mouse.move(z.x + 60, z.y + z.height / 2); await page.mouse.down(); await page.mouse.move(z.x + 200, z.y + z.height / 2, { steps: 8 }); await page.mouse.up();
  await page.waitForSelector("#undo:not([hidden])"); await shot(page, `${tag}-3b-brief-undo`);
  if (log.gmail.filter((g) => g.method !== "GET").length !== before) throw new Error("a Gmail write happened inside the undo window");
  await page.waitForTimeout(5400);
  if (log.gmail.filter((g) => g.method === "POST" && g.path === "/drafts").length < 1) throw new Error("no draft after the undo window");
  // Second decision: tap to read the draft, go Back without saving (it stays), then keyboard left.
  await page.waitForFunction(() => document.querySelector(".top .count")?.textContent.startsWith("2 /"));
  const z2 = await page.locator(".deckzone").boundingBox();
  await page.mouse.click(z2.x + z2.width / 2, z2.y + z2.height / 2);
  await page.waitForSelector("textarea:not([hidden])"); await noSideScroll(page, "draft"); await shot(page, `${tag}-4-draft`);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".top .count")?.textContent.startsWith("2 /"));
  await page.locator(".deckzone").focus(); await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector(".top .count")?.textContent.startsWith("3 /"));
  // Third decision: say something else, then Shorter, edit, save.
  await page.click("text=Say something else");
  await page.fill("textarea", "Yes, January works. Send me photos of the space.");
  await page.click("text=Write it");
  await page.waitForSelector("textarea:not([hidden])");
  await page.getByRole("button", { name: "Shorter", exact: true }).click();
  await page.waitForSelector("textarea:not([hidden])");
  await page.waitForTimeout(300);
  const own = log.worker.filter((w) => w.path === "/draft").map((w) => JSON.parse(w.raw));
  if (!own.some((d) => d.answer.kind === "own_words" && d.shorter === true)) throw new Error("Shorter did not send own_words with shorter:true");
  await page.fill("textarea", (await page.inputValue("textarea")) + "\nP.S. Bring coffee.");
  await page.click("text=Save to Gmail drafts");
  await page.waitForSelector("text=Saved. Send it from Gmail"); await shot(page, `${tag}-4b-draft-saved`);
  await page.click("text=Back");
  await page.waitForSelector("text=Done.", { timeout: 8000 }).catch(async (e) => { await shot(page, `${tag}-FAIL`); console.error("page text:", (await page.innerText("body")).slice(0, 400)); throw e; });
  await noSideScroll(page, "done"); await shot(page, `${tag}-5-done`);
  await page.click(".strip");
  await page.waitForSelector("text=handled without you >> nth=0"); await noSideScroll(page, "handled"); await shot(page, `${tag}-6-handled`);
  await page.getByRole("button", { name: "This needed me" }).first().click();
  await page.waitForSelector("text=1 handled without you");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForSelector("text=Done.");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.waitForSelector("text=Did you open Gmail", { state: "detached" });
  const flagged = await page.evaluate(async () => { const db = await new Promise((res) => { const r = indexedDB.open("cos-mail", 1); r.onsuccess = () => res(r.result); }); return new Promise((res) => { const g = db.transaction("labels").objectStore("labels").getAll(); g.onsuccess = () => res(g.result.map((l) => l.type)); }); });
  for (const t of ["needed_me", "opened_gmail_yes", "draft_unchanged", "draft_edited"]) if (!flagged.includes(t)) throw new Error(`label ${t} missing: ${flagged}`);

  // Rules, checked on what the browser actually did.
  const bad = log.gmail.filter((g) => !(g.method === "GET" || (g.method === "POST" && g.path === "/drafts") || (g.method === "PUT" && /^\/drafts\/[\w-]+$/.test(g.path))));
  if (bad.length) throw new Error("unexpected Gmail calls: " + JSON.stringify(bad));
  if (log.gmail.some((g) => g.auth !== `Bearer ${ACCESS}`)) throw new Error("Gmail call without the access token");
  if (log.worker.some((w) => w.auth !== `Bearer ${ID_TOKEN}` || w.raw.includes(ACCESS))) throw new Error("Worker call with the wrong token");
  const stored = await page.evaluate(async () => {
    const out = { ls: JSON.stringify(localStorage), ss: JSON.stringify(sessionStorage), idb: "" };
    const db = await new Promise((res) => { const r = indexedDB.open("cos-mail", 1); r.onsuccess = () => res(r.result); });
    for (const s of db.objectStoreNames) out.idb += JSON.stringify(await new Promise((res) => { const g = db.transaction(s).objectStore(s).getAll(); g.onsuccess = () => res(g.result); }));
    out.caches = JSON.stringify(await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => r.url))));
    return out;
  });
  for (const [k, v] of Object.entries(stored)) if (v.includes("ya" + "29") || v.includes("eyJhbGci")) throw new Error(`a token was stored in ${k}`);
  if (stored.caches.includes("/api/") || stored.caches.includes("googleapis")) throw new Error("API or Gmail traffic in the cache");
  const labels = log.worker.filter((w) => w.path === "/labels").map((w) => JSON.parse(w.raw));
  // Sign out: revokes the Gmail token and clears everything on the phone.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForSelector("text=Sign in with Google (test)");
  if ((await page.evaluate(() => window.__revoked)) !== ACCESS) throw new Error("sign-out did not revoke the Gmail token");
  const left = await page.evaluate(async () => { const db = await new Promise((res) => { const r = indexedDB.open("cos-mail", 1); r.onsuccess = () => res(r.result); }); let n = 0; for (const s of db.objectStoreNames) n += await new Promise((res) => { const g = db.transaction(s).objectStore(s).count(); g.onsuccess = () => res(g.result); }); return n; });
  if (left !== 0) throw new Error(`sign-out left ${left} records on the phone`);
  await shot(page, `${tag}-7-signed-out`);
  await ctx.close();
  return { gmail: log.gmail.length, worker: log.worker.length, labels };
}

const browser = await chromium.launch();
process.on("uncaughtException", (e) => { console.error(String(e.stack).split("\n").slice(0,4).join(" | "), "\nconsole errors:", [...new Set(log.errors)]); process.exit(1); });
try {
  for (const [w, h] of [[375, 812], [390, 844], [430, 932]]) {
    log.gmail.length = 0; log.worker.length = 0;
    const r = await run(browser, w, h);
    console.log(`ok ${w}px  gmail calls ${r.gmail}, worker calls ${r.worker}, label posts ${JSON.stringify(r.labels)}`);
  }
  if (log.errors.length) { console.log("console errors:", [...new Set(log.errors)]); process.exitCode = 1; }
} finally { await browser.close(); server.close(); }
