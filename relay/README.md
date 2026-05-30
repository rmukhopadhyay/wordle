# Twordle relay

A tiny, free-tier **Cloudflare Worker + KV** that store-and-forwards encoded game
state between the two players' devices, so a remote 2-player match syncs
automatically instead of relying on a hand-shuttled share link.

It is intentionally dumb: it stores the exact opaque blob `encodeGame()` already
produces, keyed by the 6-char game id, and enforces a monotonic `turnCounter` so
a stale write can't clobber a newer one. The front end stays on GitHub Pages; this
is the only server-side piece, and it's effectively free forever at
friends-and-family scale.

The client always treats the relay as **best-effort** — if it's unreachable, the
app silently falls back to the existing manual share-link / QR flow. So deploying
this never breaks anything; it just makes the happy path nicer.

---

## What is "wrangler"?

`wrangler` is Cloudflare's command-line tool for Workers — the equivalent of what
`git` is to GitHub. You use it to log in, create the KV storage, and push
(`deploy`) the Worker code to Cloudflare's edge. It's a Node package you run from
your terminal. You'll use it maybe four times total here, then almost never again.

---

## One-time setup

### 1. Create a free Cloudflare account
Go to <https://dash.cloudflare.com/sign-up>, sign up with an email + password,
and verify the email. No credit card required for the Workers free tier. You do
**not** need to add a domain or change any DNS — Workers get a free
`*.workers.dev` URL.

### 2. Make sure you have Node.js
Wrangler runs on Node. Check:
```bash
node --version    # any v18+ is fine
```
If it's missing, install it from <https://nodejs.org> (LTS) or via Homebrew:
`brew install node`.

### 3. Log wrangler into your account
From this `relay/` directory:
```bash
cd relay
npx wrangler login
```
This opens a browser window asking you to authorize Wrangler against the account
you just created. Approve it. (`npx` runs wrangler without a global install; if
you'd rather install it once, `npm install -g wrangler` and drop the `npx`.)

### 4. Create the KV namespace
This is the actual storage bucket the Worker reads/writes:
```bash
npx wrangler kv namespace create GAMES
```
It prints something like:
```
[[kv_namespaces]]
binding = "GAMES"
id = "a1b2c3d4e5f6...."
```
Copy that `id` value and paste it into `wrangler.toml`, replacing
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`.

### 5. Deploy
```bash
npx wrangler deploy
```
On success it prints your Worker URL, e.g.:
```
https://twordle-relay.<your-subdomain>.workers.dev
```
**Save that URL** — it goes into the `RELAY_URL` constant in `index.html` in the
next step of the build (client integration). Until that constant is set, the app
behaves exactly as it does today.

---

## Verify it works

Replace `<URL>` with your Worker URL:
```bash
# Should 404 (nothing stored yet):
curl -i "<URL>/g/test01"

# Store a fake record:
curl -i -X PUT "<URL>/g/test01" \
  -H 'Content-Type: application/json' \
  -d '{"v":"hello","tc":1}'

# Fetch it back (200, returns the record):
curl -i "<URL>/g/test01"

# A stale write (same/lower tc) should 409 and return the current record:
curl -i -X PUT "<URL>/g/test01" \
  -H 'Content-Type: application/json' \
  -d '{"v":"older","tc":1}'

# A newer write (higher tc) should 200:
curl -i -X PUT "<URL>/g/test01" \
  -H 'Content-Type: application/json' \
  -d '{"v":"newer","tc":2}'
```

---

## Updating later
After editing `worker.js`, just re-run:
```bash
npx wrangler deploy
```

## Useful odds and ends
- **Logs:** `npx wrangler tail` streams live request logs while you test.
- **Local run:** `npx wrangler dev` runs the Worker on `localhost` against a local
  KV simulation.
- **Free-tier limits:** 100,000 requests/day and generous KV operations — orders
  of magnitude more than this game will ever use. If it somehow blew past that,
  the Worker would start returning errors and the app would fall back to manual
  share links; nothing breaks, and that's the cue to re-evaluate.

## CORS / origins
`worker.js` only accepts requests from the origins listed in `ALLOWED_ORIGINS`
(your GitHub Pages URL + `localhost:8765` for local dev). If you move to a custom
domain, add it there and re-deploy.
