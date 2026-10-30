// The Worker client. Sends only the Google ID token. Never the Gmail access token.
import { apiBase } from "./config.js";

export class ApiError extends Error {
  constructor({ status, code, message, field = null, resetsAt = null }) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.resetsAt = resetsAt;
  }
}

export function createApi({ getIdToken, base = apiBase(), fetchImpl = (url, init) => fetch(url, init) }) {
  async function post(path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getIdToken();
      let res;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      } catch {
        throw new ApiError({ status: 0, code: "offline", message: "Could not reach the server. Check your connection and try again." });
      }
      if (res.ok) return res.json();
      let err = {};
      try { err = (await res.json()).error ?? {}; } catch { /* not JSON */ }
      if (res.status === 401 && attempt === 0) continue; // getIdToken refreshes when it is near expiry; try once more
      throw new ApiError({
        status: res.status,
        code: err.code ?? "internal",
        message: err.message ?? "Something went wrong. Try again in a minute.",
        field: err.field ?? null,
        resetsAt: err.resets_at ?? null,
      });
    }
    throw new ApiError({ status: 401, code: "unauthorized", message: "Your sign-in has expired. Sign in with Google again." });
  }
  return {
    sort: (b) => post("/sort", b),
    extract: (b) => post("/extract", b),
    draft: (b) => post("/draft", b),
    labels: (b) => post("/labels", b),
  };
}
