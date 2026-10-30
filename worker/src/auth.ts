import { HttpError } from "./errors";

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SKEW_S = 60;
const DEFAULT_CACHE_S = 300;
const MAX_TOKEN_LEN = 8192;

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
  use?: string;
}

interface JwksCache {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
}

let cache: JwksCache | null = null;
let inflight: Promise<JwksCache> | null = null;
let lastFetchAt = -Infinity;
const UNKNOWN_KID_REFETCH_MS = 60_000;

/** Test hook: forget cached Google keys. */
export function resetJwksCache(): void {
  cache = null;
  inflight = null;
  lastFetchAt = -Infinity;
}

function maxAgeSeconds(cacheControl: string | null): number {
  const m = cacheControl ? /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl) : null;
  if (!m || !m[1]) return DEFAULT_CACHE_S;
  return Math.min(Number(m[1]), 24 * 3600);
}

async function fetchKeys(nowMs: number): Promise<JwksCache> {
  const res = await fetch(GOOGLE_CERTS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("certs fetch failed");
  const data = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of data.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid || (jwk.alg && jwk.alg !== "RS256")) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  return { keys, expiresAt: nowMs + maxAgeSeconds(res.headers.get("cache-control")) * 1000 };
}

async function getKey(kid: string, nowMs: number): Promise<CryptoKey | null> {
  const fresh = cache !== null && cache.expiresAt > nowMs;
  if (fresh && cache!.keys.has(kid)) return cache!.keys.get(kid) ?? null;
  // Unknown kid on a fresh cache (Google may have rotated keys): refetch at most
  // once per UNKNOWN_KID_REFETCH_MS, otherwise reject without a network call.
  if (fresh && nowMs - lastFetchAt < UNKNOWN_KID_REFETCH_MS) return null;
  if (!inflight) {
    lastFetchAt = nowMs;
    inflight = fetchKeys(nowMs).finally(() => {
      inflight = null;
    });
  }
  cache = await inflight;
  return cache.keys.get(kid) ?? null;
}

function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> {
  const v = JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("bad json");
  return v as Record<string, unknown>;
}

export interface IdClaims {
  email: string;
  name: string;
}

/**
 * A4.2: verify a Google ID token (RS256 against Google's published keys),
 * iss, aud, exp (60 s skew) and email_verified. Any failure is 401 unauthorized.
 */
export async function verifyIdToken(authHeader: string | null, clientId: string, nowMs: number): Promise<IdClaims> {
  const fail = () => new HttpError("unauthorized");
  if (!authHeader) throw fail();
  const m = /^Bearer\s+(\S+)$/.exec(authHeader.trim());
  if (!m || !m[1] || m[1].length > MAX_TOKEN_LEN) throw fail();
  const parts = m[1].split(".");
  if (parts.length !== 3) throw fail();
  const [h, p, s] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let sig: Uint8Array;
  try {
    header = b64urlJson(h);
    payload = b64urlJson(p);
    sig = b64urlDecode(s);
  } catch {
    throw fail();
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw fail();

  let key: CryptoKey | null;
  try {
    key = await getKey(header.kid, nowMs);
  } catch {
    throw fail();
  }
  if (!key) throw fail();

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw fail();

  const nowS = Math.floor(nowMs / 1000);
  if (typeof payload.iss !== "string" || !ISSUERS.has(payload.iss)) throw fail();
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.length === 1 && aud[0] === clientId : aud === clientId;
  if (!audOk) throw fail();
  if (typeof payload.exp !== "number" || payload.exp + SKEW_S <= nowS) throw fail();
  if (typeof payload.nbf === "number" && payload.nbf - SKEW_S > nowS) throw fail();
  if (typeof payload.iat === "number" && payload.iat - SKEW_S > nowS) throw fail();
  if (payload.email_verified !== true) throw fail();
  if (typeof payload.email !== "string" || !payload.email.includes("@")) throw fail();

  const email = payload.email.trim().toLowerCase();
  const rawName = typeof payload.name === "string" ? payload.name.trim() : "";
  const name = rawName || email.split("@")[0] || email;
  return { email, name };
}
