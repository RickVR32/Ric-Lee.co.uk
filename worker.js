/**
 * Ric Lee — Basket/Quote → Telegram relay
 * ---------------------------------------
 * Cloudflare Worker. Receives a POSTed basket from the web-development.html
 * or app-software-development.html configurator checkout, and forwards it
 * as a plain-text message to Rick's Telegram via the Bot API.
 *
 * The Telegram bot token must never live in the site's own JS (anyone could
 * read it from the page source and spam-message through your bot), so this
 * worker is the only thing that holds it, as a secret set via `wrangler secret`.
 *
 * See SETUP.md in this same folder for the exact deploy steps.
 */

// Only requests from these origins are served. Add your real domain(s) here
// once ric-lee.co.uk is confirmed; keep localhost only while testing locally.
const ALLOWED_ORIGINS = [
  'https://ric-lee.co.uk',
  'https://www.ric-lee.co.uk',
  'http://localhost:8080'
];

export default {
  async fetch(request, env) {
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

    const text = buildMessage({ name, contact, notes, source, tier, discountCode, page, items, oneOff, discounted, recurring });

    const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: text,
        disable_web_page_preview: true
      })
    });

    if (!tgRes.ok) {
      const errText = await tgRes.text().catch(() => '');
      return json({ ok: false, error: 'telegram_failed', detail: errText.slice(0, 200) }, 502, corsHeaders);
    }

    return json({ ok: true }, 200, corsHeaders);
  }
};

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
