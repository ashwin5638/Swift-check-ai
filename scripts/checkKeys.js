import { env } from '../src/config.js';

/**
 * Read-only credential validation. Every probe is a GET that changes nothing:
 * no posts, no uploads, no messages sent.
 *
 * Run this after rotating keys: `npm run check:keys`
 */

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = { ok: '✔', warn: '!', fail: '✖' }[status];
  console.log(`  ${mark}  ${name.padEnd(26)} ${detail}`);
}

async function groq() {
  if (!env.groqApiKey) return record('GROQ_API_KEY', 'fail', 'not set');
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${env.groqApiKey}` }
  });
  if (!res.ok) return record('GROQ_API_KEY', 'fail', `HTTP ${res.status}`);
  const { data } = await res.json();
  record('GROQ_API_KEY', 'ok', `valid · ${data.length} models available`);
}

async function pexels() {
  if (!env.pexelsApiKey) return record('PEXELS_API_KEY', 'fail', 'not set');
  const res = await fetch('https://api.pexels.com/v1/search?query=ship&per_page=1', {
    headers: { Authorization: env.pexelsApiKey }
  });
  if (!res.ok) return record('PEXELS_API_KEY', 'fail', `HTTP ${res.status}`);
  const remaining = res.headers.get('x-ratelimit-remaining');
  const limit = res.headers.get('x-ratelimit-limit');
  record('PEXELS_API_KEY', 'ok', `valid · ${remaining}/${limit} requests left this month`);
}

async function facebook() {
  const { pageId, pageAccessToken, graphVersion } = env.facebook;
  if (!pageAccessToken || !pageId) return record('FACEBOOK', 'fail', 'page id or token not set');

  // A Page access token cannot read the /me/accounts edge (that is a User
  // token edge), so read the Page node directly instead.
  const url = `https://graph.facebook.com/${graphVersion}/${pageId}?fields=id,name,access_token&access_token=${pageAccessToken}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.error) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    const hint = /permission|scope|login/i.test(msg)
      ? ' — app is missing pages_read_engagement/pages_manage_posts, or the token is not for this Page'
      : '';
    return record('FACEBOOK', 'fail', `${msg}${hint}`);
  }
  if (data.id !== pageId) return record('FACEBOOK', 'fail', `token does not resolve to PAGE_ID ${pageId}`);
  record('FACEBOOK', 'ok', `valid · "${data.name}" (${data.id})`);
}

async function linkedin() {
  const { memberId, accessToken, apiVersion } = env.linkedin;
  if (!accessToken) return record('LINKEDIN', 'fail', 'access token not set');

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Linkedin-Version': apiVersion.replace(/^v/, ''),
    'X-Restli-Protocol-Version': '2.0.0'
  };

  const res = await fetch('https://api.linkedin.com/v2/userinfo', { headers });
  const data = await res.json().catch(() => ({}));

  if (res.ok && data.sub) {
    const mismatch = memberId && memberId !== data.sub;
    return record('LINKEDIN', mismatch ? 'fail' : 'ok',
      mismatch
        ? `token valid for "${data.name}" but MEMBER_ID ${memberId} != ${data.sub}`
        : `valid · ${data.name} · member id ${data.sub}`);
  }

  // /v2/userinfo needs the `openid` scope. A token minted with only
  // w_member_social has no read scope at all and genuinely cannot introspect
  // itself — that is "unverified", not "invalid". The only authoritative test
  // is an actual post, which this script will never do.
  const msg = data.message || data.error || `HTTP ${res.status}`;
  const noReadScope = /NO_VERSION|Not enough permissions/i.test(JSON.stringify(msg));
  record('LINKEDIN', noReadScope ? 'warn' : 'fail',
    noReadScope
      ? 'unverified — token has no read scope (w_member_social only); valid on first real post'
      : `${msg}`);
}

async function telegram() {
  const { botToken, chatId } = env.telegram;
  if (!botToken) return record('TELEGRAM', 'fail', 'bot token not set');
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) return record('TELEGRAM', 'fail', data.description || 'invalid token');
  record('TELEGRAM', 'ok', `valid · @${data.result.username}${chatId ? ` · chat id set` : ' · CHAT_ID missing'}`);
}

console.log('\nCredential check (read-only)\n');
for (const [label, check] of Object.entries({ groq, pexels, facebook, linkedin, telegram })) {
  try {
    await check();
  } catch (err) {
    record(label, 'fail', err.message);
  }
}

const failed = results.filter((r) => r.status === 'fail');
const warned = results.filter((r) => r.status === 'warn');

console.log('');
if (warned.length) {
  console.log(`${warned.length} unverified: ${warned.map((r) => r.name).join(', ')}`);
}
if (failed.length) {
  console.log(`${failed.length} of ${results.length} checks FAILED.`);
  process.exit(1);
}
console.log(`${results.length - warned.length} of ${results.length} credentials confirmed valid.`);
if (warned.length) process.exit(0);
