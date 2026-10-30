import { verifyIdToken } from "./auth";
import type { Meter } from "./claude";
import { corsHeaders, isAllowedOrigin } from "./cors";
import { isoSeconds } from "./day";
import type { Env, Tester } from "./env";
import { HttpError } from "./errors";
import { emailHash } from "./hash";
import { BYTES_MAX, chargeCap } from "./limits";
import { logRequest } from "./log";
import type { Handler } from "./endpoints/context";
import { draft } from "./endpoints/draft";
import { extract } from "./endpoints/extract";
import { labels } from "./endpoints/labels";
import { share } from "./endpoints/share";
import { sort } from "./endpoints/sort";

export const ROUTES: Record<string, Handler> = {
  "/api/sort": sort,
  "/api/extract": extract,
  "/api/draft": draft,
  "/api/share": share,
  "/api/labels": labels,
};

function json(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > BYTES_MAX) throw new HttpError("too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError("bad_request", { field: "body" });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BYTES_MAX) {
      await reader.cancel();
      throw new HttpError("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError("bad_request", { field: "body" });
  }
}

/**
 * Order (A4): origin, then ID token, then allowlist, then method and path,
 * then body size, then schema and item limits, then the daily cap, then the model.
 */
async function handle(request: Request, env: Env, meter: Meter, who: { tester: Tester | null }, nowMs: number): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) throw new HttpError("bad_origin");
  const cors = corsHeaders(origin as string);

  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const claims = await verifyIdToken(request.headers.get("authorization"), env.GOOGLE_CLIENT_ID, nowMs);
    const hash = await emailHash(env.EMAIL_HASH_KEY, claims.email);
    const tester: Tester = { email: claims.email, name: claims.name, hash };
    who.tester = tester;

    const allowed = await env.COS_KV.get(`allow:${claims.email}`);
    if (allowed === null) throw new HttpError("not_on_list");

    if (request.method !== "POST") throw new HttpError("method_not_allowed");
    const handler = ROUTES[new URL(request.url).pathname];
    if (!handler) throw new HttpError("not_found");

    const body = await readBody(request);
    const result = await handler({
      env,
      tester,
      body,
      meter,
      nowMs,
      charge: (counter, mode) => chargeCap(env, hash, counter, mode, nowMs),
    });
    return json(200, JSON.stringify(result), cors);
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError("internal");
    const extra: Record<string, string> = { ...cors };
    if (e.code === "method_not_allowed") extra.Allow = "POST, OPTIONS";
    return json(e.status, e.body(), extra);
  }
}

/** Endpoint name for the log: a known path, or "other" so no request text reaches the log. */
function endpointName(request: Request): string {
  try {
    const p = new URL(request.url).pathname;
    return p in ROUTES ? p : "other";
  } catch {
    return "other";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const meter: Meter = { model: null, in: 0, out: 0 };
    const who: { tester: Tester | null } = { tester: null };
    let response: Response;
    try {
      response = await handle(request, env, meter, who, started);
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError("internal");
      response = json(e.status, e.body());
    }
    logRequest({
      t: isoSeconds(started),
      tester: who.tester?.hash ?? null,
      endpoint: endpointName(request),
      model: meter.model,
      in: meter.in,
      out: meter.out,
      status: response.status,
      ms: Date.now() - started,
    });
    return response;
  },
} satisfies ExportedHandler<Env>;
