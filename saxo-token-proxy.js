/**
 * Cloudflare Worker — multi-purpose proxy for MSTR Options Simulator
 *
 * Routes:
 *   POST /          → Saxo token exchange (PKCE, avoids CORS)
 *   GET  /yahoo     → Yahoo Finance spot price or options chain (avoids CORS)
 *   GET  /saxo      → Proxy any Saxo OpenAPI call (avoids CORS)
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

const BROWSER_HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

// CF Workers: getAll('set-cookie') is a non-standard extension; fall back gracefully.
function extractCookies(response) {
  try {
    if (typeof response.headers.getAll === 'function') {
      return response.headers.getAll('set-cookie').map(c => c.split(';')[0]).join('; ');
    }
    // Standard Fetch: get() joins multiple Set-Cookie with ', ' which breaks values
    // — split on ", " then re-join name=value pairs
    const raw = response.headers.get('set-cookie') || '';
    return raw.split(/,\s*(?=[A-Za-z_][^=]*=)/).map(c => c.split(';')[0].trim()).join('; ');
  } catch (_) { return ''; }
}

async function fetchYahooOptions(ticker) {
  // ── Step 1: get session cookies from fc.yahoo.com (lightweight, no consent wall) ──
  let cookieStr = '';
  try {
    const fcResp = await fetch('https://fc.yahoo.com', {
      headers: BROWSER_HDRS,
      redirect: 'follow',
    });
    cookieStr = extractCookies(fcResp);
  } catch (_) {}

  // ── Step 2: obtain crumb tied to the session cookie ──
  let crumb = '';
  if (cookieStr) {
    try {
      const crumbResp = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { ...BROWSER_HDRS, Cookie: cookieStr },
      });
      if (crumbResp.ok) crumb = (await crumbResp.text()).trim();
    } catch (_) {}
  }

  // ── Step 3: try multiple endpoints with and without crumb ──
  const hdrs = cookieStr ? { ...BROWSER_HDRS, Cookie: cookieStr } : BROWSER_HDRS;
  const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';

  const endpoints = [
    // With crumb + cookie (preferred)
    `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?lang=en-US&region=US${crumbParam}`,
    `https://query2.finance.yahoo.com/v8/finance/options/${ticker}?lang=en-US&region=US${crumbParam}`,
    // Without crumb (fallback — sometimes works from server IPs)
    `https://query2.finance.yahoo.com/v8/finance/options/${ticker}?lang=en-US&region=US`,
    `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?lang=en-US&region=US`,
  ];

  let lastResp;
  let lastBody;
  for (const ep of endpoints) {
    try {
      lastResp = await fetch(ep, { headers: hdrs });
      lastBody = await lastResp.text();
      if (lastResp.ok) return { ok: true, status: lastResp.status, body: lastBody };
    } catch (e) {
      lastBody = String(e);
    }
  }

  // All failed — return last error body so client can inspect what Yahoo said
  return {
    ok: false,
    status: lastResp?.status ?? 502,
    body: JSON.stringify({
      error: 'yahoo_options_all_failed',
      last_status: lastResp?.status,
      crumb_obtained: !!crumb,
      cookie_obtained: !!cookieStr,
      last_body_snippet: (lastBody || '').slice(0, 500),
    }),
  };
}

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
        const type = url.searchParams.get('type') || 'chart';

        if (type === 'options') {
          const result = await fetchYahooOptions(ticker);
          return new Response(result.body, {
            status: result.ok ? 200 : result.status,
            headers: { 'Content-Type': 'application/json', ...CORS(origin) },
          });
        }

        // Spot price chart — no auth needed
        const chartUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
        const resp = await fetch(chartUrl, { headers: BROWSER_HDRS });
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

    // ── GET /saxo — proxy any Saxo OpenAPI call (avoids CORS) ──
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
        const auth = request.headers.get('Authorization') || '';
        const resp = await fetch(base + path, { headers: { Authorization: auth } });
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
      return new Response(JSON.stringify({ ok: true, worker: 'mstr-proxy', routes: ['POST / (Saxo token)', 'GET /yahoo', 'GET /yahoo?type=options', 'GET /saxo'] }), {
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
      const env = params.get('saxo_env') || 'live';
      params.delete('saxo_env');
      const tokenUrl = env === 'sim'
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
