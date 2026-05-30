// Twordle relay — a dumb, best-effort store-and-forward for encoded game state.
//
// It never understands the game. It shuttles the same opaque LZ-string blob that
// `encodeGame` already produces for the URL hash, keyed by the 6-char game id,
// and enforces a monotonically increasing turnCounter so a stale write can never
// clobber a newer one. That counter check is what closes the "stale link
// overwrites state" gap noted in CLAUDE.md.
//
// Runtime: a single free-tier Cloudflare Worker + one KV namespace (binding GAMES).
//
// Routes:
//   GET  /g/:id  -> 200 { v, tc, savedAt }   (404 if unknown)
//   PUT  /g/:id  -> 200 { ok, tc }           (409 + current record if stale)
//
// The client treats every call as best-effort: any failure falls back to the
// existing manual share-link / QR flow, so the relay is an optimization, never a
// hard dependency. That matters for the flaky-network scenarios this is for.

const TTL_SECONDS = 7 * 24 * 60 * 60; // mirror the client's 7-day SAVE_TTL_MS

// Lock this to your GitHub Pages origin. If you serve from a custom domain too,
// add it here and pick the matching one per request.
const ALLOWED_ORIGINS = [
  'https://rmukhopadhyay.github.io',
  'http://localhost:8765', // local dev (python3 -m http.server 8765)
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    // Game ids are 6 base32 chars (see randomGameId in index.html); allow a bit
    // of slack so a future longer relay token still routes.
    const match = url.pathname.match(/^\/g\/([a-z0-9]{4,40})$/);
    if (!match) return json({ error: 'not_found' }, 404, cors);
    const key = `g:${match[1]}`;

    if (request.method === 'GET') {
      const stored = await env.GAMES.get(key);
      if (!stored) return json({ error: 'no_game' }, 404, cors);
      return new Response(stored, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    if (request.method === 'PUT') {
      let incoming;
      try {
        incoming = await request.json();
      } catch (e) {
        return json({ error: 'bad_json' }, 400, cors);
      }
      if (typeof incoming.v !== 'string' || typeof incoming.tc !== 'number') {
        return json({ error: 'missing_v_or_tc' }, 400, cors);
      }

      // Compare-and-set: only accept strictly-newer state. If the incoming turn
      // counter isn't ahead of what we hold, the caller is on a stale branch —
      // hand back the current record (409) so they can reconcile.
      const existing = await env.GAMES.get(key);
      if (existing) {
        try {
          const prev = JSON.parse(existing);
          if (typeof prev.tc === 'number' && incoming.tc <= prev.tc) {
            return new Response(existing, {
              status: 409,
              headers: { 'Content-Type': 'application/json', ...cors },
            });
          }
        } catch (e) {
          // Corrupt existing record — fall through and overwrite it.
        }
      }

      const record = JSON.stringify({
        v: incoming.v,
        tc: incoming.tc,
        savedAt: Date.now(),
      });
      await env.GAMES.put(key, record, { expirationTtl: TTL_SECONDS });
      return json({ ok: true, tc: incoming.tc }, 200, cors);
    }

    return json({ error: 'method_not_allowed' }, 405, cors);
  },
};
