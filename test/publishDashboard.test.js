import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readPublishedUrls, selectPublishable } from '../scripts/publishDashboard.js';

/**
 * The published dashboard data is the only copy of the run history that reaches
 * the internet, and the only pointer to reels that live in a store nothing else
 * indexes. These tests pin the retention rules, because the failure mode is
 * silent: a reel quietly stops playing and the run log still looks fine.
 */

/** A run shaped like the real record, newest-first ordering is the caller's job. */
function run(id, { video = true } = {}) {
  return {
    id,
    startedAt: '2026-09-26T06:55:03.000Z',
    finishedAt: '2026-09-26T06:56:41.000Z',
    durationMs: 98_000,
    status: 'published',
    media: video
      ? { videoUrl: `/media/${id}.mp4`, durationSeconds: 15, sizeBytes: 8_734_912 }
      : null,
    script: { headline: `Headline ${id}` }
  };
}

const withVideo = (ids) => ids.map((id) => run(id));
const videoIdsOf = (records) =>
  records.filter((r) => r.media?.videoUrl).map((r) => r.id);

test('every run that has media keeps it inside the video window', () => {
  const ids = ['a', 'b', 'c'];
  const { records, videoIds } = selectPublishable(withVideo(ids));

  assert.deepEqual(records.map((r) => r.id), ids, 'all three ship as records');
  assert.deepEqual([...videoIds], ids, 'all three are inside the 5-reel window');
});

test('videos are capped but records are not, so the log outlives the footage', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `run-${i}`);
  const { records, videoIds } = selectPublishable(withVideo(ids));

  assert.equal(records.length, 12, 'every record is kept');
  assert.equal(videoIds.size, 5, 'but only the newest five reels are kept');
  assert.deepEqual(
    [...videoIds],
    ['run-0', 'run-1', 'run-2', 'run-3', 'run-4'],
    'and they are the newest five, since state.js unshifts'
  );
});

test('the record and video caps are independently overridable', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `run-${i}`);
  const { records, videoIds } = selectPublishable(withVideo(ids), {
    maxRecords: 30,
    maxVideos: 2
  });

  assert.equal(records.length, 30, 'the record cap applies on its own');
  assert.equal(videoIds.size, 2, 'the video cap applies on its own');
});

test('a run with no media never consumes a slot in the video window', () => {
  // --no-render runs land in the history with media: null. Counting them would
  // push a real reel out of the window for no reason.
  const runs = [run('skipped', { video: false }), run('a'), run('b'), run('c'), run('d'), run('e'), run('f')];
  const { records, videoIds } = selectPublishable(runs, { maxVideos: 5 });

  assert.equal(records.length, 7, 'the render-skipped run still ships as a record');
  assert.deepEqual([...videoIds], ['a', 'b', 'c', 'd', 'e'], 'the five real reels take the window');
});

test('an already-pruned reel is not resurrected on the next publish', () => {
  // media.videoUrl is null in the published copy, so there is no absolute URL to
  // recover and the run must not be treated as a live Blob object.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-')), 'runs.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      runs: [
        { ...run('fresh'), media: { videoUrl: 'https://store.example/reels/fresh.mp4' } },
        { ...run('stale'), media: { videoUrl: null } }
      ]
    })
  );

  const urls = readPublishedUrls(file);
  assert.deepEqual([...urls.keys()], ['fresh'], 'only the run with a Blob URL is tracked');
  assert.equal(urls.get('fresh'), 'https://store.example/reels/fresh.mp4');
});

test('the relative /media path in state is not mistaken for a Blob URL', () => {
  // If this regressed, every publish would treat the local path as an uploaded
  // reel, skip the upload, and hand the dashboard a 404 for every video.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-')), 'runs.json');
  fs.writeFileSync(file, JSON.stringify({ runs: [run('local-only')] }));

  assert.equal(readPublishedUrls(file).size, 0);
});

test('a missing or corrupt published file reads as an empty store, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  assert.equal(readPublishedUrls(path.join(dir, 'nope.json')).size, 0);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(readPublishedUrls(bad).size, 0);
});
