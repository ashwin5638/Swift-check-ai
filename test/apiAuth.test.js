/**
 * The passphrase gate.
 *
 * These are the only lines of code in the project that decide whether a stranger
 * with the URL can spend Facebook and LinkedIn tokens, so the interesting cases
 * are the ones that are easy to get subtly wrong: an unset passphrase, a
 * truncated cookie, a tampered expiry, and a token signed with a rotated secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COOKIE_NAME,
  SESSION_MAX_AGE_SEC,
  checkPassphrase,
  clearSessionCookie,
  isAuthed,
  issueToken,
  issueSession,
  parseCookies,
  requireAuth,
  sessionCookie,
  verifyToken
} from '../api/_lib/auth.js';

const PASS = 'correct horse battery staple';
const NOW = 1_700_000_000_000;

/** The moment a token issued at NOW stops being valid. */
const EXPIRED_AT = (Math.floor(NOW / 1000) + SESSION_MAX_AGE_SEC) * 1000;

/** Minimal stand-in for an Express request, since the helper reads two things. */
const request = (headers = {}, body = undefined) => ({ headers, body });

/** Minimal response that records what the middleware did to it. */
const response = () => ({
  statusCode: null,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  }
});

test('the right passphrase passes and every other one does not', () => {
  assert.equal(checkPassphrase(PASS, PASS), true);
  assert.equal(checkPassphrase('Correct horse battery staple', PASS), false, 'case matters');
  assert.equal(checkPassphrase(`${PASS} `, PASS), false, 'no trimming: a trailing space is not the passphrase');
  assert.equal(checkPassphrase('', PASS), false);
  assert.equal(checkPassphrase(undefined, PASS), false);
});

test('parseCookies reads a single header and copes with the other shapes', () => {
  assert.deepEqual(parseCookies(`${COOKIE_NAME}=abc`), { [COOKIE_NAME]: 'abc' });
  // Every cookie in the header comes back, not just ours. This is a general
  // parser and isAuthed picks its own key out of the jar (api/_lib/auth.js), so
  // returning only dash_session would be wrong for any caller wanting a second
  // cookie — and would make this assertion, rather than the code, the contract.
  assert.deepEqual(parseCookies(`other=1; ${COOKIE_NAME}=abc; more=2`), {
    other: '1',
    [COOKIE_NAME]: 'abc',
    more: '2'
  });
  // A bare `dash_session` with no `=` is dropped, so it can never be read as a
  // session. Asserted as an absent key rather than an empty jar: `a=1` is a
  // well-formed cookie and is correctly kept.
  assert.equal(COOKIE_NAME in parseCookies(`a=1; ${COOKIE_NAME}`), false, 'a key with no value is not a session');
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('malformed-without-equals'), {});
});

test('a token survives the round trip and dies exactly at its expiry', () => {
  const token = issueToken(PASS, NOW);
  assert.equal(verifyToken(token, PASS, NOW), true);
  // The last millisecond it holds and the first it does not. An off-by-one here
  // either strands a session forever or outlives the window by a hair.
  assert.equal(verifyToken(token, PASS, EXPIRED_AT - 1), true);
  assert.equal(verifyToken(token, PASS, EXPIRED_AT), false);
});

test('a token signed with another secret does not verify', () => {
  const token = issueToken('a different passphrase', NOW);
  assert.equal(verifyToken(token, PASS, NOW), false);
});

test('the MAC is checked before the timestamp is believed', () => {
  // Both fields come off the same attacker-controlled string. Verifying the
  // expiry first would let anyone mint a session valid until the year 2100 by
  // typing their own.
  const forged = `${Math.floor(EXPIRED_AT / 1000) + 86_400_000}.whatever`;
  assert.equal(verifyToken(forged, PASS, NOW), false);
});

test('every field of a token is load-bearing', () => {
  const token = issueToken(PASS, NOW);
  const [expiry, mac] = token.split('.');
  assert.equal(verifyToken(`${expiry}x.${mac}`, PASS, NOW), false, 'edited expiry');
  assert.equal(verifyToken(`${expiry}.${mac.slice(0, -1)}0`, PASS, NOW), false, 'edited signature');
  assert.equal(verifyToken(`${expiry}.${mac}extra`, PASS, NOW), false, 'appended junk');
  assert.equal(verifyToken(expiry, PASS, NOW), false, 'missing signature');
  assert.equal(verifyToken(`.${mac}`, PASS, NOW), false, 'missing expiry');
  assert.equal(verifyToken('notanumber.' + mac, PASS, NOW), false, 'a non-numeric expiry cannot pass the MAC');
});

test('a missing or malformed token is refused rather than throwing', () => {
  // A cold start serves a cookie-less first request. That is the normal case, not
  // an error, so it must resolve to false and not to a 500.
  for (const token of [undefined, null, '', 'nonsense', '...', 'abc.def', '1.2.3']) {
    assert.equal(verifyToken(token, PASS, NOW), false);
  }
});

test('isAuthed follows the cookie', () => {
  assert.equal(isAuthed(request({ cookie: `${COOKIE_NAME}=${issueToken(PASS, Date.now())}` }), PASS), true);
  assert.equal(isAuthed(request({ cookie: `${COOKIE_NAME}=forged.sig` }), PASS), false);
  assert.equal(isAuthed(request(), PASS), false);
});

test('the session cookie is httpOnly, SameSite=Lax, and only secure in production', () => {
  const token = issueToken(PASS, Date.now());
  const secure = sessionCookie(token, { secure: true });
  assert.match(secure, new RegExp(`^${COOKIE_NAME}=${token}`), 'sets the token');
  assert.match(secure, /HttpOnly/i, 'script cannot read the session');
  assert.match(secure, /SameSite=Lax/i, 'CSRF defence');
  assert.match(secure, /Secure/i);
  assert.match(secure, new RegExp(`Max-Age=${SESSION_MAX_AGE_SEC}`), 'an explicit lifetime');

  // Secure is dropped over http, so the local console on :5173 still gets a
  // session. Without this the developer is the only person who can test.
  assert.doesNotMatch(sessionCookie(token, { secure: false }), /;\s*Secure/i);

  const cleared = clearSessionCookie({ secure: false });
  assert.match(cleared, new RegExp(`^${COOKIE_NAME}=;`), 'clears the same name');
  assert.match(cleared, /Max-Age=0/i, 'expiring it is what clears it');
});

test('a write route admits a valid session and turns away everyone else', () => {
  const gate = requireAuth(PASS, { secure: false });
  const good = () => {
    const req = request({ cookie: `${COOKIE_NAME}=${issueToken(PASS, Date.now() + 60_000)}` });
    let passed = false;
    gate(req, response(), () => {
      passed = true;
    });
    return passed;
  };

  assert.equal(good(), true, 'a valid cookie goes through');

  const anonymous = response();
  gate(request(), anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.body.code, 'unauthenticated', 'the client keys its login prompt off this');

  const forged = response();
  gate(request({ cookie: `${COOKIE_NAME}=a.b` }), forged);
  assert.equal(forged.statusCode, 401, 'a hand-made cookie is not a session');
});

test('an unset passphrase answers 503, so the console says "missing", not "wrong"', () => {
  // 401 here would render the passphrase prompt, and every submission would
  // fail, leaving an operator staring at what looks like a wrong password.
  for (const missing of ['', undefined, null]) {
    const gate = requireAuth(missing, { secure: false });
    const res = response();
    gate(request({ cookie: `${COOKIE_NAME}=${issueToken(PASS, Date.now())}` }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'no-passphrase');
  }
});

test('requireAuth reads the passphrase per request, not at import time', () => {
  // The middleware is built once at module load. If it snapshotted the
  // passphrase then, a secret that rotates between deploys would keep
  // authenticating against the value the instance happened to start with.
  let secret = 'first';
  const gate = requireAuth(() => secret, { secure: false });

  const admit = (withSecret) => {
    const req = request({ cookie: `${COOKIE_NAME}=${issueToken(withSecret, Date.now() + 60_000)}` });
    let passed = false;
    gate(req, response(), () => {
      passed = true;
    });
    return passed;
  };

  assert.equal(admit('first'), true);

  secret = 'second';
  assert.equal(admit('first'), false, 'a cookie from the old secret dies the moment the secret changes');
  assert.equal(admit('second'), true);
});

test('issueSession mints a token and hands it out only as a Set-Cookie', () => {
  const res = { setHeader(name, value) { this[name] = value; } };
  const token = issueSession(res, PASS, { secure: false });

  assert.equal(verifyToken(token, PASS, Date.now()), true);
  assert.match(res['Set-Cookie'], new RegExp(`^${COOKIE_NAME}=${token}`), 'the token never leaves any other field');
});
