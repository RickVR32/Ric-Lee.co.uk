/**
 * Ric Lee — Basket/Quote → Telegram relay + pending-quotes queue
 * ----------------------------------------------------------------
 * Cloudflare Worker. Receives a POSTed basket from the web-development.html
 * or app-software-development.html configurator checkout, and:
 *   1. forwards it as a plain-text message to Rick's Telegram via the Bot API
 *   2. stores it in Workers KV as a "pending quote", so the private Ric Lee
 *      Hub can pull it in and turn it into a client project card
 *
 * Why the queue exists: the Hub is a Claude Artifact, and its shared database
 * can only be written to by the signed-in viewer's own browser session — there
 * is no server-to-server API this public worker could call to write into it
 * directly. So instead, every basket submission is held here in KV until the
 * Hub (open in Rick's browser) fetches GET /pending and acks it with
 * POST /ack, at which point it's deleted from the queue.
 *
 * The Telegram bot token must never live in the site's own JS (anyone could
 * read it from the page source and spam-message through your bot), so this
 * worker is the only thing that holds it, as a secret set via `wrangler secret`.
 * The same applies to HUB_SECRET below, which gates /pending and /ack so a
 * stranger can't read or clear out the quote queue.
 *
 * See SETUP.md in this same folder for the exact deploy steps.
 */

// Only requests from these origins are served for the basket/checkout POST.
// Add your real domain(s) here once ric-lee.co.uk is confirmed; keep
// localhost only while testing locally.
const ALLOWED_ORIGINS = [
  'https://ric-lee.co.uk',
  'https://www.ric-lee.co.uk',
  'http://localhost:8080'
];

// How long an unacked quote stays in the queue before it's dropped, so a
// forgotten item doesn't sit there forever. 30 days.
const PENDING_TTL_SECONDS = 60 * 60 * 24 * 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/pending') {
      return handlePending(request, env);
    }
    if (url.pathname === '/ack') {
      return handleAck(request, env);
    }
    return handleBasketSubmit(request, env);
  }
};

// ---------------------------------------------------------------------------
// Basket submission (existing behaviour) — POST to the worker's root URL,
// exactly as web-development.html / app-software-development.html already do.
// ---------------------------------------------------------------------------
async function handleBasketSubmit(request, env) {
  const origin = request.headers.get('Origin') || '';
  const corsHeaders = buildCorsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);
  }

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, corsHeaders);
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json({ ok: false, error: 'not_configured' }, 500, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'invalid_json' }, 400, corsHeaders);
  }

  // Honeypot field — real visitors never fill a hidden "company" input.
  // Pretend success so a bot doesn't learn it was caught.
  if (clean(body.company, 200)) {
    return json({ ok: true }, 200, corsHeaders);
  }

  const name = clean(body.name, 120);
  const contact = clean(body.contact, 200);
  const notes = clean(body.notes, 1000);
  const source = clean(body.source, 60) || 'unknown page';
  const tier = clean(body.tier, 200);
  const discountCode = clean(body.discountCode, 40);
  const page = clean(body.page, 300);
  const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
  const oneOff = numberOrNull(body.oneOff);
  const discounted = numberOrNull(body.discounted);
  const recurring = numberOrNull(body.recurring);

  if (!name || !contact) {
    return json({ ok: false, error: 'missing_fields' }, 400, corsHeaders);
  }

  const basket = { name, contact, notes, source, tier, discountCode, page, items, oneOff, discounted, recurring, total: discounted != null ? discounted : oneOff };

  const text = buildMessage(basket);

  const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text,
      disable_web_page_preview: true
    })
  });

  // Queue it for the Hub to pick up regardless of whether the Telegram alert
  // went through — a dropped Telegram message shouldn't also lose the lead.
  // If no KV binding is configured yet, skip this step silently (the basket
  // flow keeps working with Telegram alone until Task #7's setup step runs).
  if (env.PENDING_QUEUE) {
    const id = (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + '-' + Math.random().toString(36).slice(2));
    const record = { id, receivedAt: Date.now(), basket };
    try {
      await env.PENDING_QUEUE.put('pending:' + id, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
    } catch (e) {
      // Queue write failing should never block the visitor's confirmation.
    }
  }

  if (!tgRes.ok) {
    const errText = await tgRes.text().catch(() => '');
    return json({ ok: false, error: 'telegram_failed', detail: errText.slice(0, 200) }, 502, corsHeaders);
  }

  return json({ ok: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// GET /pending — the Hub calls this (with the shared secret) to list every
// quote request that hasn't been converted into a project card yet.
// ---------------------------------------------------------------------------
async function handlePending(request, env) {
  const hubCors = buildHubCorsHeaders();

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: hubCors });
  }
  if (request.method !== 'GET') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, hubCors);
  }
  if (!checkHubSecret(request, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401, hubCors);
  }
  if (!env.PENDING_QUEUE) {
    return json({ ok: false, error: 'queue_not_configured' }, 500, hubCors);
  }

  const items = [];
  try {
    const list = await env.PENDING_QUEUE.list({ prefix: 'pending:' });
    for (const key of list.keys) {
      const raw = await env.PENDING_QUEUE.get(key.name);
      if (raw) {
        try { items.push(JSON.parse(raw)); } catch (e) { /* skip malformed entry */ }
      }
    }
  } catch (e) {
    return json({ ok: false, error: 'queue_read_failed' }, 502, hubCors);
  }

  items.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
  return json({ ok: true, items }, 200, hubCors);
}

// ---------------------------------------------------------------------------
// POST /ack — the Hub calls this once it has turned a pending item into a
// project card, so it's removed from the queue and never shown again.
// ---------------------------------------------------------------------------
async function handleAck(request, env) {
  const hubCors = buildHubCorsHeaders();

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: hubCors });
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, hubCors);
  }
  if (!checkHubSecret(request, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401, hubCors);
  }
  if (!env.PENDING_QUEUE) {
    return json({ ok: false, error: 'queue_not_configured' }, 500, hubCors);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'invalid_json' }, 400, hubCors);
  }

  const id = clean(body.id, 200);
  if (!id) {
    return json({ ok: false, error: 'missing_id' }, 400, hubCors);
  }

  try {
    await env.PENDING_QUEUE.delete('pending:' + id);
  } catch (e) {
    return json({ ok: false, error: 'queue_delete_failed' }, 502, hubCors);
  }

  return json({ ok: true }, 200, hubCors);
}

function checkHubSecret(request, env) {
  if (!env.HUB_SECRET) return false; // refuse rather than leave the queue open if unset
  const provided = request.headers.get('X-Hub-Secret') || '';
  return provided === env.HUB_SECRET;
}

function buildMessage(d) {
  var lines = [];
  lines.push('New basket request — ' + d.source);
  lines.push('');
  lines.push('Name: ' + d.name);
  lines.push('Contact: ' + d.contact);
  if (d.tier) lines.push('Tier: ' + d.tier);
  lines.push('');
  lines.push('Selected:');
  d.items.forEach(function (it) {
    var label = clean(it && it.label, 160);
    var itemText = clean(it && it.text, 60);
    if (label) lines.push('- ' + label + (itemText ? ' (' + itemText + ')' : ''));
  });
  lines.push('');
  var total = d.discounted != null ? d.discounted : d.oneOff;
  if (total != null) lines.push('Total: £' + Math.round(total).toLocaleString('en-GB'));
  if (d.recurring) lines.push('Ongoing: £' + Math.round(d.recurring) + '/mo');
  if (d.discountCode) lines.push('Code used: ' + d.discountCode);
  if (d.notes) { lines.push(''); lines.push('Notes: ' + d.notes); }
  if (d.page) { lines.push(''); lines.push('From: ' + d.page); }
  return lines.join('\n');
}

function buildCorsHeaders(origin) {
  var allowed = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

// /pending and /ack are called from the Hub artifact, which runs on a
// claude.ai-controlled origin rather than ric-lee.co.uk, so they can't use
// the same fixed-origin allowlist as the basket submit endpoint above.
// The shared secret (checked in checkHubSecret) is what actually protects
// these two routes, so a permissive CORS origin here is safe — without it
// the Hub page simply couldn't read the response.
function buildHubCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Secret',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {})
  });
}

function clean(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen);
}

function numberOrNull(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}
