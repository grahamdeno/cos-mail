# COS Mail page

A static PWA: plain JavaScript modules, no build step, no runtime dependencies. It signs in with Google, reads Gmail with a one-hour token held in memory, calls the Worker under `/api`, and saves replies as Gmail drafts. It never sends mail.

```
public/
  index.html, styles.css, manifest.webmanifest, sw.js, _headers, icons/
  js/
    app.js      state, actions, screen switch
    screens.js  the six screens (Connect, Reveal, Brief, Done, Handled, Draft) plus a loading screen
    auth.js     Google sign-in; the ID token and the Gmail token live in memory only
    gmail.js    Gmail REST: reads, create draft, update draft. A guard blocks every other call
    api.js      the Worker client; sends only the ID token
    flow.js     list, sort, read, quote check, keep derived items; drafts; label counts
    store.js    IndexedDB: ledger, decisions, labels, handled reasons. Refuses anything credential-shaped
    swipe.js, undo.js, trim.js, quote.js, words.js, day.js, dom.js, config.js
test/    node:test, no dependencies. Includes the static no-send, no-token-storage and no-secrets checks
e2e/     a real-browser run with Google, Gmail and the Worker faked (needs Playwright; not in CI)
```

## Run it

```
cd web
npm test                      # unit and static tests (Node 22.18 or newer)
tsc -p .                      # type check (checkJs)
node e2e/run.mjs /tmp/shots   # full flow at 375, 390 and 430 px, with screenshots
```

To use it by hand, serve `public/` on `http://localhost:<port>` (any static server). On localhost the page calls the live Worker at `https://cos.tangomike.app/api`, which the Worker's CORS allows. Sign in with an account on the tester list.

## Deploy (Cloudflare Pages)

Not done yet. It replaces the temporary DNS record, so it waits for Graham.

1. Cloudflare dashboard, Workers & Pages, Create, Pages, connect `grahamdeno/cos-mail`. Project name `cos-mail-web`. Production branch `main`. Root directory `web`. Build command: none. Build output directory: `public`.
2. In the Pages project, Custom domains, add `cos.tangomike.app`.
3. DNS change this needs (Graham approves it): in the `tangomike.app` zone, delete the temporary record `AAAA cos -> 100::` (proxied). Pages creates `CNAME cos -> cos-mail-web.pages.dev` (proxied) when the custom domain is added. If Pages reports that a record already exists, delete the AAAA first and add the domain again.
4. Leave the Worker route `cos.tangomike.app/api/*` alone. Worker routes run before Pages, so `/api/*` still goes to the Worker.
5. Check: `https://cos.tangomike.app/` loads the Connect screen, and an unauthenticated `POST https://cos.tangomike.app/api/sort` still returns 401 `unauthorized`.

`public/_headers` sets a Content-Security-Policy for Google sign-in, Gmail and the Worker. It has not been tried against a real Google sign-in. If sign-in is blocked in the browser console with a CSP error, loosen only the directive named in the error.

## Rules the code keeps (each has a test)

- Nothing can send, delete, trash, relabel or import mail. `gmail.js` only allows GET, `POST /drafts` and `PUT /drafts/<id>`.
- Tokens: the ID token goes only to the Worker, the Gmail token only to Gmail. Neither is written to any storage, cache or log. No refresh tokens, no offline access.
- The Gmail draft is created only after the 5-second undo window closes. Leaving the page inside the window cancels the action.
- Every promise and decision carries a quote. The page checks it again, the same way the Worker does: the quote must be in the right thread, at least two words, really in that message, and in the right person's words (the tester's for "I owe", the other person's for "owed to me" and for questions).
- Notes to self (mail between the tester's own addresses) are neither sorted nor read by the model.
- Anything shaped like an API key, token or private key is replaced with "[key removed]" before mail leaves the phone.
- Mail bodies are held in memory for one run. IndexedDB holds derived items only.
- Mail text goes into the page as text nodes. There is no `innerHTML`.
