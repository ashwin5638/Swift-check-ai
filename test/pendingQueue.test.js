import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addPendingPost,
  getPendingPost,
  listPendingPosts,
  resolvePendingPost,
  savePendingPosts,
  loadPendingPosts
} from '../server/lib/state.js';

const VIDEO = 'output/test-run.mp4';
const URL = 'https://t.me/channel/1';

function reset() {
  savePendingPosts([]);
}

test('adds a pending post and reads it back by id', () => {
  reset();
  const entry = addPendingPost({
    id: 'run-a',
    headline: 'Hormuz volumes surge',
    storyTitle: 'Tanker traffic jumps',
    platforms: ['facebook'],
    videoPath: VIDEO,
    videoUrl: URL,
    durationSeconds: 15,
    sizeBytes: 1024
  });

  assert.equal(entry.status, 'pending');
  assert.ok(entry.createdAt);
  assert.equal(getPendingPost('run-a').headline, 'Hormuz volumes surge');
  assert.equal(listPendingPosts().length, 1);
});

test('re-running the publisher for one run updates instead of duplicating', () => {
  reset();
  addPendingPost({ id: 'run-a', headline: 'first', platforms: ['facebook'], videoPath: VIDEO });
  addPendingPost({ id: 'run-a', headline: 'second', platforms: ['linkedin'], videoPath: VIDEO });

  const all = listPendingPosts({ includeResolved: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].headline, 'second');
  assert.deepEqual(all[0].platforms, ['linkedin']);
  // A re-queue must reopen the entry rather than leave it resolved.
  assert.equal(all[0].status, 'pending');
});

test('resolve records the outcome and a timestamp', () => {
  reset();
  addPendingPost({ id: 'run-a', platforms: ['facebook'], videoPath: VIDEO });

  const approved = resolvePendingPost('run-a', 'approved');
  assert.equal(approved.status, 'approved');
  assert.ok(approved.resolvedAt);
  assert.equal(listPendingPosts().length, 0);
  assert.equal(listPendingPosts({ includeResolved: true }).length, 1);
});

test('resolve stores the failure reason', () => {
  reset();
  addPendingPost({ id: 'run-a', platforms: ['facebook'], videoPath: VIDEO });

  const failed = resolvePendingPost('run-a', 'failed', { error: 'token expired' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'token expired');
});

test('resolving an unknown id throws so the API can answer 404', () => {
  reset();
  assert.throws(() => resolvePendingPost('missing', 'approved'), /not found/i);
});

test('resolving twice throws so a double-click cannot overwrite an outcome', () => {
  reset();
  addPendingPost({ id: 'run-a', platforms: ['facebook'], videoPath: VIDEO });
  resolvePendingPost('run-a', 'approved');
  assert.throws(() => resolvePendingPost('run-a', 'rejected'), /already approved/i);

  // The first outcome must survive the rejected attempt.
  assert.equal(getPendingPost('run-a').status, 'approved');
});

test('list returns pending entries only unless history is requested', () => {
  reset();
  addPendingPost({ id: 'run-a', platforms: ['facebook'], videoPath: VIDEO });
  addPendingPost({ id: 'run-b', platforms: ['linkedin'], videoPath: VIDEO });
  resolvePendingPost('run-b', 'approved');

  assert.deepEqual(listPendingPosts().map((e) => e.id), ['run-a']);
  assert.equal(listPendingPosts({ includeResolved: true }).length, 2);
});

test('history is capped so a long-lived install cannot grow without bound', () => {
  reset();
  for (let i = 0; i < 45; i++) {
    addPendingPost({ id: `run-${i}`, platforms: ['facebook'], videoPath: VIDEO });
  }
  const all = listPendingPosts({ includeResolved: true });
  assert.equal(all.length, 30);
  // Newest first: the oldest entries are the ones dropped.
  assert.equal(all[0].id, 'run-44');
  assert.ok(!all.some((e) => e.id === 'run-0'));
});

test('a corrupt state file degrades to an empty queue instead of crashing', () => {
  const bad = { pending: 'not-an-array' };
  savePendingPosts(bad);
  assert.equal(loadPendingPosts().length, 0);
  reset();
});
