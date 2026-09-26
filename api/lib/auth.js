import crypto from 'node:crypto';

/**
 * Gate for the mutating routes.
 *
 * The local API on :4000 has no authentication at all, and does not need any:
 * it binds to loopback (server/config.js) and its CORS allowlist accepts only
 * localhost origins, so nothing off the machine can drive it. A Vercel function
 * has neither property — every route is a public URL on the internet — so
 * POST /api/runs/:id/publish would otherwise let a stranger post to the Facebook
 * page and the LinkedIn account.
 *
 * The read routes stay open. The console is a dashboard about public content, and
 * a run log is useful to whoever follows marine news; requiring a login to look
 * at it buys nothing. What must be gated is the ability to spend credentials.
 *
 * Why a passphrase and not a token in the client bundle: VITE_* values are
 * inlined into the JavaScript, so any secret shipped to the browser is public to
 * everyone who opens devtools. The passphrase is compared here, on the server, and
 * only a derived cookie is ever handed out. Changing DASHBOARD_PASS invalidates
 * every outstanding session immediately, which is the property you want when
 * rotating a secret.
 */

export const COOKIE_NAME = 'dash_session';
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/** Both are hashed so the comparison is over equal-length buffers regardless of input length. */
const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();

export function checkPassphrase(candidate, expected) {
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
}

function sign(passphrase, expiry) {
  return crypto.createHmac('sha256', passphrase).update(String(expiry)).digest('base64url');
}

/**
 * A stateless session: `<expiry>.<hmac>`. No session store, because a Vercel
 * function's memory is per-instance and a store in module scope would authenticate
 * the first visitor of a warm instance and reject everyone else.
 */
export function issueToken(passphrase, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + SESSION_MAX_AGE_SEC;
  return `${expiry}.${sign(passphrase, expiry)}`;
}

/**
 * The MAC is verified before `expiry` is believed. Both come off the same
 * attacker-controlled string, so checking the timestamp first would let anyone
 * mint a session valid until the year 2100 by setting the field.
 */
export function verifyToken(token, passphrase, now = Date.now()) {
  if (typeof token !== 'string') return false;

  const [expiry, mac] = token.split('.');
  if (!expiry || !mac) return false;

  const expected = sign(passphrase, expiry);
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;

  const expiresAtMs = Number(expiry) * 1000;
  return Number.isFinite(expiresAtMs) && expiresAtMs > now;
}

/** Hand-rolled because Express carries no cookie serialiser and this is five attributes. */
export function sessionCookie(token, { secure = true, maxAgeSec = SESSION_MAX_AGE_SEC } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: the console is same-origin so either works, and Lax still
    // survives a top-level navigation from an external link, which Strict would
    // turn into a logged-out console with no explanation.
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie({ secure = true } = {}) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function parseCookies(header) {
  const jar = {};
  if (!header) return jar;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    try {
      jar[key] = decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is not worth a 500 on a header we only read
      // to find one cookie in.
      jar[key] = raw;
    }
  }
  return jar;
}

export function isAuthed(req, passphrase) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  return verifyToken(token, passphrase);
}

/**
 * A deployment with no DASHBOARD_PASS set answers 503 rather than 401. The
 * distinction matters: 401 would render the passphrase prompt, and submitting any
 * passphrase would fail, so the console would sit there looking like a wrong
 * password rather than a missing one.
 *
 * `passphrase` may be a string or a getter. The getter matters for testability
 * and for not baking an import-time snapshot of the environment into a module
 * that lives for the life of the deployment.
 */
export function requireAuth(passphrase, { secure = true } = {}) {
  const secret = typeof passphrase === 'function' ? passphrase : () => passphrase;

  return (req, res, next) => {
    const pass = secret();
    if (!pass) {
      return res.status(503).json({
        error: 'DASHBOARD_PASS is not set on this deployment, so the controls are disabled.',
        code: 'no-passphrase'
      });
    }
    if (isAuthed(req, pass)) return next();
    res.status(401).json({ error: 'Sign in to control the pipeline.', code: 'unauthenticated' });
  };
}

export function issueSession(res, passphrase, options) {
  const token = issueToken(passphrase);
  res.setHeader('Set-Cookie', sessionCookie(token, options));
  return token;
}
