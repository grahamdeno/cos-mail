/**
 * A4.1: the Origin header must be one of ALLOWED_ORIGINS. An `http://localhost`
 * entry allows any port on localhost. CORS answers only those origins.
 */
export function isAllowedOrigin(origin: string | null, allowedCsv: string): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // An Origin header is scheme://host[:port] only.
  if (url.origin !== origin) return false;
  const allowed = allowedCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of allowed) {
    if (entry === origin) return true;
    let a: URL;
    try {
      a = new URL(entry);
    } catch {
      continue;
    }
    if (a.hostname === "localhost" && url.hostname === "localhost" && a.protocol === url.protocol) {
      return true;
    }
  }
  return false;
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
