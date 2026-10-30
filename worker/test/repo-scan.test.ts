import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Hard stop 1: no code path sends mail. This test fails the build if either
 * Gmail send method name appears anywhere in the repo. The names are built by
 * concatenation so this file does not contain them itself.
 */
const FORBIDDEN_SEND = ["messages" + ".send", "drafts" + ".send"];

/** Hard stops 2 and 7: no keys or secrets in the repo. Prefixes built by concatenation too. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Anthropic API key", new RegExp("sk-" + "ant-[A-Za-z0-9_-]{10,}")],
  ["Google OAuth client secret", new RegExp("GOC" + "SPX-[A-Za-z0-9_-]{10,}")],
  ["Google OAuth access token", new RegExp("ya" + "29\\.[A-Za-z0-9_-]{20,}")],
  ["Google refresh token", new RegExp("1//" + "0[A-Za-z0-9_-]{20,}")],
  ["Google API key", new RegExp("AI" + "za[0-9A-Za-z_-]{35}")],
  ["GitHub token", new RegExp("gh" + "[pousr]_[A-Za-z0-9]{30,}")],
  ["Private key", new RegExp("-----BEGIN [A-Z ]*PRIVATE" + " KEY-----")],
];

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile() && st.size < 5_000_000) out.push(p);
  }
  return out;
}

const files = walk(REPO_ROOT);

describe("repo scan", () => {
  it("scans the whole repo (sanity)", () => {
    const rel = files.map((f) => relative(REPO_ROOT, f));
    expect(rel).toContain("README.md");
    expect(rel).toContain(join("worker", "src", "index.ts"));
    expect(rel).toContain(join("worker", "test", "repo-scan.test.ts"));
  });

  it("no Gmail send call names anywhere in the repo", () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const s of FORBIDDEN_SEND) if (text.includes(s)) hits.push(`${relative(REPO_ROOT, f)}: ${s}`);
    }
    expect(hits).toEqual([]);
  });

  it("no keys, tokens or client secrets in the repo", () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${relative(REPO_ROOT, f)}: ${label}`);
    }
    expect(hits).toEqual([]);
  });

  it("wrangler.toml holds no secret names as vars", () => {
    const toml = readFileSync(join(REPO_ROOT, "worker", "wrangler.toml"), "utf8");
    expect(toml).not.toMatch(/ANTHROPIC_API_KEY\s*=/);
    expect(toml).not.toMatch(/EMAIL_HASH_KEY\s*=/);
  });
});
