# COS Mail API Worker (step 2)

Cloudflare Worker behind `cos.tangomike.app/api/*`. It checks the Google ID token, the tester allowlist and the daily caps, forwards trimmed mail to the Claude Messages API, and forgets it. It never calls Gmail, never stores or logs mail, and logs one line per request: tester hash, endpoint, model, tokens, status and latency.

Endpoints: `POST /api/sort`, `/api/extract`, `/api/draft`, `/api/share`, `/api/labels` (contract: spec Appendix A).

## Develop

```sh
cd worker
npm ci
npx tsc --noEmit
npm test
```

Tests use no network: Google certs and the Anthropic API are mocked, ID tokens are signed with a throwaway RSA key, and KV is in memory.

## Secrets

`ANTHROPIC_API_KEY` and `EMAIL_HASH_KEY` are Worker secrets, set by Graham with `npx wrangler secret put`. They never go in this repo or in `wrangler.toml`.

## Prompts and the eval

`src/prompts.ts` holds the sort, extract and draft prompts and tool schemas (step 4). `src/quote.ts` holds the item check every promise and decision must pass: same thread, at least two words, found in that message after normalizing, and in the right person's words.

`eval/` is a labeled set of synthetic threads (no real mail) and a live eval that runs them through the same model calls the Worker makes. It scores promise and decision recall, extra items, due dates, status, must-not-find phrases (including an injection attempt), sort misses and draft rules.

```
ANTHROPIC_API_KEY=... npm run eval
```

In CI it runs on pushes that touch the prompts or the eval, only when the repository secret `ANTHROPIC_EVAL_KEY` is set. Each run costs a few cents.
