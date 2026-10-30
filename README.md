# COS Mail

Chief of Staff Mail (COS Mail) is a small beta web app that reads a tester's Gmail, asks a few decisions each morning, and saves suggested replies as Gmail drafts for the tester to review. It never sends mail. This repo is public and holds no keys, tokens or mail: secrets live only in Cloudflare Worker secrets, and mail text passes through the Worker without being stored or logged.

- `worker/`: the API Worker (live at `cos.tangomike.app/api`).
- `web/`: the page (a static PWA). See `web/README.md`.
