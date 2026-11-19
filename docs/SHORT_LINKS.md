# Short share links (19 Nov 2026)

**Share link** in the stage builder and the roadbook editor now copies a short link such as
`https://rrearth.wyans.net/s/p6uL21G62Dj56529cD3rGA` (50 characters instead of 10,000+), which fits in Discord and text messages.

- **Copy long link** (builder: File tab; editor: toolbar) still makes the old `#s1=` / `#r1=` link that carries the data
  itself. Old long links open exactly as before.
- If the short link can't be made (offline, service error, rate limit, too big), Share copies the long link automatically
  and says why.
- Opening `/s/<id>` serves the builder (stage) or the editor (roadbook); the page fetches `/api/share/<id>`, loads it, and
  the address changes back to the normal page address.

## Server (deploy/stagebuilder/worker.js)

| Route | What it does |
|---|---|
| `POST /api/share` | body `{"v":1,"kind":"stage"\|"roadbook","data":"<the compressed #s1=/#r1= payload>"}` → `201 {"id","url"}` |
| `GET /api/share/<id>` | the stored record (immutable, cached for a year) or 404 |
| `GET /s/<id>` | the right page with `<base href="/">` and a `rr-short` marker; 404 status if unknown |

- ID: 22 random base62 characters from `crypto.getRandomValues` (about 131 bits); not guessable, no listing endpoint.
- Checks: same-site Origin only, `application/json`, 256 KB body cap, 4 MB cap after unpacking, exact keys, and the
  payload must unpack to a rally.raid stage or roadbook.
- Rate limit per IP (only a salted hash of the IP is used): 10 per minute (Workers rate-limit binding `SHARE_RL`) and
  20 per 10 minutes (KV counter). Both are approximate: Cloudflare counts per location, and KV reads can lag ~60 s.
- Storage: KV namespace `rrearth-shares` (binding `SHARES`), free tier: 1 GB, 100k reads and 1k writes a day. One
  upload is 2 writes (record + counter), so about 500 new links a day before the free daily write limit. Links don't expire.

## Tests

- `BASE=http://127.0.0.1:8799 RATE=1 node tests/shortlinks/api_test.js` (wrangler dev, or a preview URL)
- `BASE=... NODE_PATH=/tmp/pp/node_modules node tests/browser/short_link_test.js`
