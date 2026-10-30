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
