// Static checks over the page's source. They fail the build if a rule from the hard-stop list is broken.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PUBLIC = join(ROOT, "web", "public");
const SKIP = new Set(["node_modules", ".git", ".wrangler"]);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.size < 2_000_000) out.push(p);
  }
  return out;
}

const read = (p) => readFileSync(p, "utf8");
/** Source without whole-line comments, so a comment that explains a rule does not trip the rule. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rel = (p) => relative(ROOT, p);
const jsFiles = walk(join(PUBLIC, "js")).filter((f) => f.endsWith(".js"));
const pageFiles = [...jsFiles, join(PUBLIC, "sw.js"), join(PUBLIC, "index.html")];
const allText = walk(join(ROOT, "web")).filter((f) => /\.(js|html|css|json|webmanifest|svg|md|mjs)$/.test(f) && !f.includes(`${join("web", "test")}`));

// Built by concatenation so this file does not contain the forbidden names itself.
const SEND_PATTERNS = [
  ["Gmail send path", new RegExp("/" + "send\\b")],
  ["messages send call", new RegExp("messages" + "[./]" + "send")],
  ["drafts send call", new RegExp("drafts" + "[./]" + "send")],
  ["a .send( call", new RegExp("\\." + "send\\(")],
  ["a Gmail delete method", new RegExp('"' + "DELETE" + '"')],
  ["trash", new RegExp("/(un)?" + "trash")],
  ["modify labels", new RegExp("/" + "modify\\b")],
  ["batch delete", new RegExp("batch" + "Delete")],
  ["import or insert", new RegExp("messages/" + "(import|insert)")],
];

test("the page's sources hold the files we expect (sanity)", () => {
  const names = jsFiles.map((f) => relative(join(PUBLIC, "js"), f)).sort();
  for (const n of ["app.js", "auth.js", "gmail.js", "api.js", "flow.js", "store.js", "screens.js", "swipe.js", "undo.js", "quote.js", "trim.js"]) assert.ok(names.includes(n), n);
});

test("hard stop: no code path can send, delete, trash, relabel or import mail", () => {
  const hits = [];
  for (const f of allText) {
    const text = read(f);
    for (const [name, re] of SEND_PATTERNS) if (re.test(text)) hits.push(`${rel(f)}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

test("only gmail.js talks to Gmail, only api.js to the Worker, and nothing else calls fetch", () => {
  const callers = jsFiles.filter((f) => /\bfetch\(/.test(read(f))).map((f) => relative(join(PUBLIC, "js"), f)).sort();
  assert.deepEqual(callers, ["api.js", "gmail.js"]);
  assert.ok(!/gmail\.googleapis\.com/.test(read(join(PUBLIC, "js", "api.js"))));
  const withGmailHost = jsFiles.filter((f) => /gmail\.googleapis\.com/.test(read(f))).map((f) => relative(join(PUBLIC, "js"), f));
  assert.deepEqual(withGmailHost, ["gmail.js"]);
});

test("hard stop: browser storage is touched only by store.js, and store.js never sees a token", () => {
  const STORAGE = /\b(localStorage|sessionStorage|indexedDB|document\.cookie|caches\.)/;
  const users = pageFiles.filter((f) => STORAGE.test(code(f))).map((f) => relative(PUBLIC, f)).sort();
  assert.deepEqual(users, ["js/store.js", "sw.js"]);
  const store = code(join(PUBLIC, "js", "store.js"));
  assert.ok(!/from "\.\/auth\.js"/.test(store));
  assert.ok(!/getAccessToken|getIdToken|accessToken|idToken/.test(store));
});

test("hard stop: the service worker never sees tokens or API traffic", () => {
  const sw = code(join(PUBLIC, "sw.js"));
  assert.ok(!/authorization|token|bearer|cookie/i.test(sw));
  assert.match(sw, /startsWith\("\/api\/"\)\) return/);
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/);
  assert.ok(!/\.put\([^)]*Authorization/i.test(sw));
});

test("hard stop: no refresh tokens and no offline access", () => {
  for (const f of pageFiles) {
    const t = read(f);
    assert.ok(!/refresh_token|access_type|offline_access|prompt:\s*["']consent["']/.test(t), rel(f));
  }
  const cfg = read(join(PUBLIC, "js", "config.js"));
  assert.ok(!/gmail\.modify|mail\.google\.com\/["']/.test(cfg), "no broad Gmail scope");
  const scopes = [...cfg.matchAll(/"((?:https:\/\/www\.googleapis\.com\/auth\/)?[a-z.]+)",?\n/g)].map((m) => m[1]);
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.compose"));
});

test("mail text only enters the page as text: no innerHTML, eval or document.write", () => {
  for (const f of pageFiles.filter((p) => p.endsWith(".js"))) {
    assert.ok(!/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function\()/.test(read(f)), rel(f));
  }
});

test("no client secret, keys or token-shaped strings in the page", () => {
  const patterns = [new RegExp("GOC" + "SPX-"), new RegExp("sk-" + "ant-"), new RegExp("ya" + "29\\.[A-Za-z0-9_-]{20,}"), new RegExp("1//" + "0[A-Za-z0-9_-]{20,}"), /client_secret/i];
  for (const f of allText) for (const re of patterns) assert.ok(!re.test(read(f)), `${rel(f)} ${re}`);
});

test("the Google client ID in the page is the Web client (public by design)", () => {
  assert.match(read(join(PUBLIC, "js", "config.js")), /456735134102-53s6afv6b316sj1bes9phmb71rc78mi5\.apps\.googleusercontent\.com/);
});

test("the page and the manifest are installable on iPhone", () => {
  const html = read(join(PUBLIC, "index.html"));
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /apple-mobile-web-app-capable/);
  const m = JSON.parse(read(join(PUBLIC, "manifest.webmanifest")));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  for (const i of m.icons) statSync(join(PUBLIC, i.src));
});

test("the service worker's shell list names real files", () => {
  const sw = read(join(PUBLIC, "sw.js"));
  const list = [...sw.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]).filter((p) => p !== "/api/" && p.length > 1 || p === "/");
  for (const p of list) {
    if (p === "/") continue;
    statSync(join(PUBLIC, p));
  }
  for (const f of jsFiles) assert.ok(sw.includes(`/js/${relative(join(PUBLIC, "js"), f)}`), `${relative(PUBLIC, f)} is in the shell cache`);
});

test("CSP lets Google's sign-in button style itself, and no wider than that", () => {
  const csp = read(join(PUBLIC, "_headers"));
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "scripts stay locked");
  assert.ok(!/style-src 'self'[^;]*'unsafe-inline'/.test(csp), "style elements stay locked");
});
