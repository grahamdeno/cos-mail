const enc = new TextEncoder();

function keyBytes(secret: string): Uint8Array {
  const s = secret.trim();
  if (s.length >= 2 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return enc.encode(s);
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A3: first 16 hex characters of HMAC-SHA256(EMAIL_HASH_KEY, lowercase email). */
export async function emailHash(secret: string, email: string): Promise<string> {
  if (!secret) throw new Error("EMAIL_HASH_KEY missing");
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(email.trim().toLowerCase()));
  return toHex(sig).slice(0, 16);
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}
