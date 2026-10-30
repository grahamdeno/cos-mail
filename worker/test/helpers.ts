import { vi } from "vitest";
import { resetJwksCache, GOOGLE_CERTS_URL } from "../src/auth";
import { ANTHROPIC_URL } from "../src/claude";
import type { Env } from "../src/env";
import worker from "../src/index";

export const CLIENT_ID = "456735134102-53s6afv6b316sj1bes9phmb71rc78mi5.apps.googleusercontent.com";
export const ORIGIN = "https://cos.tangomike.app";
export const TESTER_EMAIL = "maria.tester@example.com";
// Test-only, made-up value. Not a real secret.
export const TEST_HASH_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/** In-memory stand-in for Workers KV. */
export class MemoryKV {
  store = new Map<string, { value: string; ttl?: number }>();

  async get(key: string, type?: string | { type?: string }): Promise<unknown> {
    const hit = this.store.get(key);
    if (!hit) return null;
    const t = typeof type === "string" ? type : type?.type;
    return t === "json" ? JSON.parse(hit.value) : hit.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, ttl: opts?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  json(key: string): unknown {
    const hit = this.store.get(key);
    return hit ? JSON.parse(hit.value) : null;
  }

  keys(prefix = ""): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

export function makeEnv(kv = new MemoryKV()): { env: Env; kv: MemoryKV } {
  const env: Env = {
    COS_KV: kv as unknown as KVNamespace,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    OWNER_EMAIL: "graham.denoyer@gmail.com",
    ALLOWED_ORIGINS: "https://cos.tangomike.app,http://localhost",
    MODEL_SORT: "claude-haiku-5-5",
    MODEL_EXTRACT: "claude-sonnet-5-5",
    MODEL_DRAFT: "claude-sonnet-5-5",
    DAY_TZ: "America/New_York",
    DAY_START_HOUR: "4",
    ANTHROPIC_API_KEY: "test-anthropic-placeholder",
    EMAIL_HASH_KEY: TEST_HASH_KEY,
  };
  return { env, kv };
}

export async function allow(kv: MemoryKV, email = TESTER_EMAIL): Promise<void> {
  await kv.put(`allow:${email}`, JSON.stringify({ role: "tester", added: "2026-10-30" }));
}

// ---------- Google ID tokens signed by a test RSA key ----------

const KID = "test-kid-1";
let keys: CryptoKeyPair | null = null;
let otherKeys: CryptoKeyPair | null = null;

async function genKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export async function setupKeys(): Promise<void> {
  keys ??= await genKey();
  otherKeys ??= await genKey();
}

const b64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

export interface TokenOpts {
  email?: string;
  name?: string;
  aud?: string;
  iss?: string;
  expIn?: number;
  email_verified?: unknown;
  wrongKey?: boolean;
  kid?: string;
}

export async function idToken(opts: TokenOpts = {}): Promise<string> {
  if (!keys || !otherKeys) throw new Error("call setupKeys first");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: opts.kid ?? KID, typ: "JWT" };
  const payload = {
    iss: opts.iss ?? "https://accounts.google.com",
    aud: opts.aud ?? CLIENT_ID,
    sub: "1234567890",
    email: opts.email ?? TESTER_EMAIL,
    email_verified: "email_verified" in opts ? opts.email_verified : true,
    name: opts.name ?? "Maria Ortiz",
    iat: now,
    exp: now + (opts.expIn ?? 3600),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = opts.wrongKey ? otherKeys.privateKey : keys.privateKey;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

// ---------- fetch mock: Google certs and the Anthropic Messages API ----------

/** A queued model reply. `tool` + `input` become a structured-output JSON text block (the name is only a label). */
export type ModelReply = { tool?: string; input?: unknown; status?: number; text?: string; stop?: string };

export interface FetchMock {
  certCalls: number;
  anthropicCalls: Array<Record<string, unknown>>;
  replies: ModelReply[];
}

export async function installFetch(): Promise<FetchMock> {
  if (!keys) throw new Error("call setupKeys first");
  resetJwksCache();
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const state: FetchMock = { certCalls: 0, anthropicCalls: [], replies: [] };
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === GOOGLE_CERTS_URL) {
      state.certCalls++;
      return new Response(JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: KID, n: jwk.n, e: jwk.e }] }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "public, max-age=21600, must-revalidate, no-transform" },
      });
    }
    if (url === ANTHROPIC_URL) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      state.anthropicCalls.push(body);
      const reply = state.replies.shift();
      if (!reply) throw new Error("no model reply queued");
      if (reply.status && reply.status !== 200) return new Response("{}", { status: reply.status });
      const content: unknown[] = [];
      if (reply.text) content.push({ type: "text", text: reply.text });
      if (reply.tool) content.push({ type: "text", text: JSON.stringify(reply.input) });
      return new Response(
        JSON.stringify({ id: "msg_test", type: "message", role: "assistant", content, stop_reason: reply.stop ?? "end_turn", usage: { input_tokens: 100, output_tokens: 20 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error("unexpected network call in test");
  });
  vi.stubGlobal("fetch", fn);
  return state;
}

// ---------- requests ----------

export interface CallOpts {
  method?: string;
  origin?: string | null;
  token?: string | null;
  rawBody?: string;
}

export async function call(env: Env, path: string, body: unknown, opts: CallOpts = {}): Promise<{ status: number; json: any; res: Response }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  const token = opts.token === undefined ? await idToken() : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const method = opts.method ?? "POST";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") init.body = opts.rawBody ?? JSON.stringify(body);
  const res = await worker.fetch(new Request(`https://cos.tangomike.app${path}`, init), env);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, res };
}

// ---------- sample bodies ----------

export const sortBody = (n = 2, mode = "daily") => ({
  mode,
  messages: Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    thread_id: `t${i}`,
    from: "Tom Henderson <tom@example.com>",
    to: [TESTER_EMAIL],
    cc: [],
    date: "2026-10-29T14:02:00Z",
    subject: "Install date",
    labels: ["INBOX"],
    body: "Can you move the install from Nov 9 to Nov 16?",
  })),
});

export const extractBody = (mode = "daily") => ({
  mode,
  today: "2026-10-30",
  threads: [
    {
      thread_id: "t1",
      subject: "Kitchen quote",
      messages: [
        { id: "m1", from: "Maria Ortiz <maria.tester@example.com>", to: ["rachel@example.com"], cc: [], date: "2026-10-22T15:10:00Z", body: "I'll send the revised quote with   soft-close hinges by Monday." },
        { id: "m2", from: "Rachel Park <rachel@example.com>", to: ["maria.tester@example.com"], cc: [], date: "2026-10-23T09:00:00Z", body: "Great. Should the hinges be soft-close or standard? Let me know by Friday." },
      ],
    },
  ],
});

export const draftBody = () => ({
  thread_id: "t2",
  subject: "Install date",
  messages: [{ id: "m2", from: "Tom Henderson <tom@example.com>", date: "2026-10-29T14:02:00Z", body: "Can you move the install from Nov 9 to Nov 16?" }],
  decision: { question: "Can you move the install from Nov 9 to Nov 16?", recommended: "Yes" },
  answer: { kind: "recommended", text: "Yes" },
  style_examples: [{ to: "tom@example.com", date: "2026-10-02T12:00:00Z", body: "Hi Tom, works for me. See you Monday. Maria" }],
  shorter: false,
});

export const draftReply = (): ModelReply => ({ tool: "write_draft", input: { subject: "Re: Install date", body: "Hi Tom,\n\nNov 16 works. [time] as before.\n\nMaria" } });
