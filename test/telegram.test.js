import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, buildApprovalMessage, buildPublishMessage, buildFailureMessage } from '../server/lib/telegram.js';

// These are pure formatters, so they can be verified without network access.
test('escapes the characters that would break Telegram HTML parse mode', () => {
  assert.equal(escapeHtml('Hormuz & the <b>Strait</b>'), 'Hormuz &amp; the &lt;b&gt;Strait&lt;/b&gt;');
  assert.equal(escapeHtml('quotes "here" and \'there\''), 'quotes "here" and \'there\'');
});

test('a hostile headline cannot inject markup into a notification', () => {
  const msg = buildApprovalMessage({
    headline: '</b><script>alert(1)</script>',
    storyTitle: 'x',
    runId: 'run-1',
    platforms: ['facebook']
  });
  assert.ok(!msg.includes('<script>'));
  assert.ok(msg.includes('&lt;script&gt;'));
});

test('ampersands in a headline survive as entities', () => {
  const msg = buildApprovalMessage({ headline: 'R&D spending & tanker rates', runId: 'r' });
  assert.ok(msg.includes('R&amp;D spending &amp; tanker rates'));
});

test('approval message names every platform the reel is queued for', () => {
  const msg = buildApprovalMessage({
    headline: 'Tanker traffic up',
    runId: 'run-2',
    platforms: ['facebook', 'linkedin'],
    dashboardUrl: 'http://localhost:4000'
  });
  assert.match(msg, /Queued for: Facebook \+ LinkedIn/);
  assert.match(msg, /Approve in the dashboard/i);
});

test('publish message reports each platform result', () => {
  const msg = buildPublishMessage({
    headline: 'Ports reopen',
    results: [
      { platform: 'facebook', status: 'posted', id: '1' },
      { platform: 'linkedin', status: 'failed', error: 'token expired' }
    ]
  });
  assert.match(msg, /Facebook/);
  assert.match(msg, /LinkedIn/);
  assert.match(msg, /token expired/);
});

test('failure message surfaces the reason and the run id', () => {
  const msg = buildFailureMessage({ runId: 'run-3', error: 'ffmpeg crashed' });
  assert.match(msg, /ffmpeg crashed/);
  assert.match(msg, /run-3/);
});

test('platform lists tolerate an empty or missing value', () => {
  const msg = buildApprovalMessage({ headline: 'h', runId: 'r', platforms: [] });
  assert.ok(msg.includes('h'));
  assert.doesNotThrow(() => buildApprovalMessage({ headline: 'h', runId: 'r' }));
});
