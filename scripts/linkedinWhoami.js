import { env } from '../server/config.js';

/**
 * Read-only LinkedIn identity check. It answers the one question a bare
 * `HTTP 403 {"message":"","status":403}` on POST /rest/posts leaves open:
 * is LINKEDIN_MEMBER_ID the member that this access token belongs to?
 *
 * Every request below is a GET. Nothing is posted, uploaded, or shared.
 *
 * Run: npm run linkedin:whoami
 */

const POST_SCOPE = 'w_member_social';
// openid + profile come from the "Sign In with LinkedIn" product. r_liteprofile
// is a legacy scope from the retired "LinkedIn Login" product and is left out.
const READ_SCOPE = 'openid profile';

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Linkedin-Version': env.linkedin.apiVersion.replace(/^v/, ''),
    'X-Restli-Protocol-Version': '2.0.0'
  };
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
}

function line(label, detail) {
  console.log(`  ${label.padEnd(24)} ${detail}`);
}

/**
 * Sets the exit code and lets Node wind down on its own. A bare process.exit()
 * after a fetch trips an assertion in Node's Windows async teardown and can mask
 * the exit code, which is the one thing this script exists to report.
 */
function finish(code) {
  process.exitCode = code;
  globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.();
}

function authorizationUrl() {
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: 'YOUR_APP_CLIENT_ID',
    redirect_uri: 'YOUR_REDIRECT_URI',
    scope: `${POST_SCOPE} ${READ_SCOPE}`
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${qs}`;
}

async function main() {
  const { memberId, accessToken, apiVersion } = env.linkedin;

  console.log('\nLinkedIn identity check (read-only)\n');

  line('LINKEDIN_API_VERSION', apiVersion);
  line('LINKEDIN_MEMBER_ID', memberId || 'not set');
  line('LINKEDIN_ACCESS_TOKEN', accessToken ? `set (${accessToken.length} chars)` : 'not set');

  if (!accessToken) {
    console.log('\nFAIL: no access token to check.\n');
    return finish(1);
  }

  const headers = buildHeaders(accessToken);
  console.log('');

  // The authoritative check. /v2/userinfo returns the token's own `sub`, which is
  // exactly the value the Posts API requires in the `author` URN.
  const me = await getJson('https://api.linkedin.com/v2/userinfo', headers);

  if (me.ok && me.data.sub) {
    const match = memberId && memberId === me.data.sub;
    line('GET /v2/userinfo', `HTTP ${me.status} · "${me.data.name}" · sub ${me.data.sub}`);
    line('author URN', `urn:li:person:${me.data.sub}`);
    console.log('');
    console.log(match
      ? `  OK  LINKEDIN_MEMBER_ID matches the token. Posts will be authored as this member.\n`
      : `  FAIL  LINKEDIN_MEMBER_ID is ${memberId} but the token belongs to ${me.data.sub}.\n` +
        `        Set LINKEDIN_MEMBER_ID=${me.data.sub} in .env — a member token can only\n` +
        `        author posts as itself, and LinkedIn answers the mismatch with a 403.\n`);
    return finish(match ? 0 : 1);
  }

  const raw = JSON.stringify(me.data);
  const noReadScope = me.status === 403 && /NO_VERSION|Not enough permissions/i.test(raw);

  line('GET /v2/userinfo', `HTTP ${me.status} · ${me.data.message || me.data.error || raw.slice(0, 120)}`);

  // Secondary signal: can the token read the member id it is configured to post
  // as? No query params — this endpoint takes the projection on the v2 form only.
  if (memberId) {
    const person = await getJson(
      `https://api.linkedin.com/rest/people/${encodeURIComponent(memberId)}`,
      headers
    );
    if (person.ok) {
      const same = String(person.data.id) === String(memberId);
      line('GET /rest/people/:id', `HTTP ${person.status} · readable · id ${person.data.id}`);
      console.log('');
      console.log(same
        ? `  OK  the token can read member ${memberId}. Identity matches; a 403 on POST /rest/posts\n` +
          `        would then mean ${POST_SCOPE} is missing from the token's scopes.\n`
        : `  FAIL  the token read ${person.data.id}, not ${memberId}. Fix LINKEDIN_MEMBER_ID.\n`);
      return finish(same ? 0 : 1);
    }
    line('GET /rest/people/:id', `HTTP ${person.status} · ${person.data.message || 'not readable'}`);
  }

  console.log('');
  if (noReadScope) {
    console.log('  UNVERIFIED  The token has no read scope, so it cannot identify itself. That is\n' +
      '             expected for a token minted with only ' + POST_SCOPE + ' — it is not a failure,\n' +
      '             but it also means LINKEDIN_MEMBER_ID cannot be checked from here.\n\n' +
      '             To make this conclusive, in the LinkedIn developer portal:\n' +
      '               1. Products -> add "Sign In with LinkedIn" (grants openid + profile)\n' +
      '                  and "Share on LinkedIn" (grants ' + POST_SCOPE + ')\n' +
      '               2. Developers -> Access Token Generator, generate a member token\n' +
      '               3. Put it in .env as LINKEDIN_ACCESS_TOKEN, then run this again\n\n' +
      '             If you would rather run the OAuth flow yourself, the scope string is:\n' +
      `               ${authorizationUrl()}\n\n` +
      '             Then set LINKEDIN_MEMBER_ID to the `sub` that /v2/userinfo returns.\n' +
      '             Until then the only authoritative test is a real post.\n');
    return finish(0);
  }

  console.log(`  FAIL  ${me.data.message || me.data.error || `HTTP ${me.status}`}\n` +
    '        Confirm the token is current and was granted ' + POST_SCOPE + '.\n');
  return finish(1);
}

await main();
