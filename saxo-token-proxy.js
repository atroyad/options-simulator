/**
 * Cloudflare Worker — multi-purpose proxy for MSTR Options Simulator
 *
 * Routes:
 *   POST /          → Saxo token exchange (PKCE, avoids CORS)
 *   GET  /yahoo     → Yahoo Finance MSTR spot price (avoids CORS)
 *   GET  /          → health check
 *
 * Deploy:
 *   1. Go to https://workers.cloudflare.com  (free account)
 *   2. Create Worker → paste this file → Deploy
 *   3. Copy the worker URL (e.g. https://saxo-proxy.YOUR-NAME.workers.dev)
 *   4. Paste it into the "Proxy URL" field in the MSTR Options tool → Live tab
 */
const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
});

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '*';
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...CORS(origin), 'Access-Control-Max-Age': '86400' },
      });
    }

    // ── GET /yahoo — proxy Yahoo Finance (spot price or options chain) ──
    if (request.method === 'GET' && url.pathname === '/yahoo') {
      try {
        const ticker = url.searchParams.get('ticker') || 'MSTR';
        const type = url.searchParams.get('type') || 'chart'; // 'chart' or 'options'
        const yahooUrl = type === 'options'
          ? `https://query2.finance.yahoo.com/v7/finance/options/${ticker}`
          : `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
        const resp = await fetch(yahooUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        const data = await resp.text();
        return new Response(data, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...CORS(origin) },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'yahoo_proxy_error', message: String(err) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...CORS(origin) },
        });
      }
    }

    // ── GET /saxo — proxy any Saxo OpenAPI call (avoids per-endpoint CORS restrictions) ──
    // Usage: GET /saxo?env=live&path=/ref/v1/instruments/contractoptionspaces?OptionRootId=2517
    // Pass Authorization header from browser — worker forwards it to Saxo.
    if (request.method === 'GET' && url.pathname === '/saxo') {
      try {
        const env = url.searchParams.get('env') || 'live';
        const path = url.searchParams.get('path') || '';
        if (!path) return new Response(JSON.stringify({ error: 'missing path param' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS(origin) },
        });
        const base = env === 'sim'
          ? 'https://gateway.saxobank.com/sim/openapi'
          : 'https://gateway.saxobank.com/openapi';
        const saxoUrl = base + path;
        const auth = request.headers.get('Authorization') || '';
        const resp = await fetch(saxoUrl, { headers: { Authorization: auth } });
        const data = await resp.text();
        return new Response(data, {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...CORS(origin) },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'saxo_proxy_error', message: String(err) }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...CORS(origin) },
        });
      }
    }

    // ── GET / — health check ──
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ ok: true, worker: 'mstr-proxy', routes: ['POST / (Saxo token)', 'GET /yahoo', 'GET /saxo'] }), {
        headers: { 'Content-Type': 'application/json', ...CORS(origin) },
      });
    }

    // ── POST / — Saxo PKCE token exchange ──
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...CORS(origin) },
      });
    }

    try {
      const body = await request.text();
      const params = new URLSearchParams(body);

      // saxo_env is our own flag — strip before forwarding
      const env = params.get('saxo_env') || 'live';
      params.delete('saxo_env');

      const tokenUrl =
        env === 'sim'
          ? 'https://sim.logonvalidation.net/token'
          : 'https://live.logonvalidation.net/token';

      const saxoResp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      const data = await saxoResp.text();
      return new Response(data, {
        status: saxoResp.status,
        headers: { 'Content-Type': 'application/json', ...CORS(origin) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'proxy_error', message: String(err) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS(origin) },
      });
    }
  },
};
