// Sign-in. Two Google tokens, kept apart and kept in memory only:
//  - the ID token (who you are) goes to the Worker;
//  - the access token (Gmail) goes only to Gmail and never leaves this file's closure except through getAccessToken().
// Nothing here touches localStorage, sessionStorage, IndexedDB, cookies or caches.
import { CONFIG } from "./config.js";

const GIS_SRC = "https://accounts.google.com/gsi/client";

export function loadGis(doc = document) {
  return new Promise((resolve, reject) => {
    if (globalThis.google?.accounts) return resolve(undefined);
    const s = doc.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve(undefined);
    s.onerror = () => reject(new Error("Could not load Google sign-in. Check your connection and try again."));
    doc.head.append(s);
  });
}

/** Read the claims of a JWT for display and expiry. The Worker does the real verification. */
export function decodeJwt(token) {
  const part = String(token).split(".")[1];
  if (!part) throw new Error("bad token");
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createAuth({ clientId = CONFIG.clientId, scopes = CONFIG.scopes, google = () => globalThis.google, now = Date.now } = {}) {
  let idToken = null;
  let idExp = 0;
  let profile = null;
  let accessToken = null;
  let accessExp = 0;
  let waiters = [];
  let waitTimer = null;
  /** @type {(kind: string) => void} */
  let onChange = () => {};

  /** @param {Error} [err] */
  function settle(err) {
    clearTimeout(waitTimer);
    const w = waiters;
    waiters = [];
    for (const x of w) err ? x.reject(err) : x.resolve(idToken);
  }

  function handleCredential(resp) {
    try {
      const c = decodeJwt(resp.credential);
      idToken = resp.credential;
      idExp = Number(c.exp) * 1000;
      profile = { email: String(c.email).toLowerCase(), name: c.name || c.email, given: c.given_name || "" };
      settle();
      onChange("signed_in");
    } catch {
      settle(new Error("Sign-in came back unreadable. Try again."));
    }
  }

  return {
    init(cb) {
      onChange = cb || onChange;
      google().accounts.id.initialize({
        client_id: clientId,
        callback: handleCredential,
        auto_select: true,
        cancel_on_tap_outside: false,
        use_fedcm_for_prompt: true,
      });
    },
    renderButton(el) {
      google().accounts.id.renderButton(el, {
        type: "standard", theme: "filled_black", size: "large", text: "continue_with", shape: "rectangular", logo_alignment: "left", width: Math.min(320, el.clientWidth || 320),
      });
    },
    prompt() { google().accounts.id.prompt(); },
    get profile() { return profile; },
    get signedIn() { return !!idToken && idExp - now() > 0; },
    hasAccess() { return !!accessToken && accessExp - now() > 60_000; },

    /** A fresh ID token for the Worker; asks Google quietly if the current one is close to expiry. */
    getIdToken() {
      if (idToken && idExp - now() > 120_000) return Promise.resolve(idToken);
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        if (waiters.length === 1) {
          google().accounts.id.prompt();
          waitTimer = setTimeout(() => settle(new Error("Your sign-in has expired. Sign in with Google again.")), 15_000);
        }
      });
    },

    /** One tap each morning. Must be called from a tap so the browser allows the Google window. */
    requestAccess() {
      return new Promise((resolve, reject) => {
        const client = google().accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: scopes,
          hint: profile?.email,
          callback: (r) => {
            if (!r || r.error) return reject(new Error(r?.error_description || r?.error || "Google did not grant access."));
            accessToken = r.access_token;
            accessExp = now() + (Number(r.expires_in) || 3600) * 1000;
            resolve(undefined);
          },
          error_callback: (e) => reject(new Error(e?.type === "popup_closed" ? "The Google window was closed before access was granted." : "Google could not open its window. Allow pop-ups and try again.")),
        });
        client.requestAccessToken({ prompt: "" });
      });
    },

    /** For Gmail calls only. Null when expired. */
    getAccessToken() { return this.hasAccess() ? accessToken : null; },

    signOut() {
      const t = accessToken;
      accessToken = null; accessExp = 0; idToken = null; idExp = 0; profile = null;
      try { if (t) google().accounts.oauth2.revoke(t, () => {}); } catch { /* best effort */ }
      try { google().accounts.id.disableAutoSelect(); } catch { /* best effort */ }
      settle(new Error("Signed out."));
    },
  };
}
