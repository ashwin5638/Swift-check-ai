import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { publishFeed, readPublishedUrls, selectPublishable } from '../scripts/publishDashboard.js';

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

/**
 * The feed is 4 KB of JSON that needs no credentials; the reels are optional. So
 * an unavailable store must cost playback and nothing else. The client reads a
 * 404 on runs.json as "no runs published yet" rather than complaining, which is
 * correct behaviour and also why a publish that never wrote the file looks
 * exactly like a fresh deployment. Nothing else would have caught it.
 */
const outFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feed-')), 'data', 'runs.json');
const readBack = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a missing token still publishes the run log, with no reel URLs', async () => {
  const file = outFile();
  const published = await publishFeed({
    stored: { runs: [run('a'), run('b')] },
    outFile: file,
    canUpload: false
  });

  assert.equal(published.length, 2, 'both records ship');
  const data = readBack(file);
  assert.deepEqual(
    data.runs.map((r) => r.id),
    ['a', 'b'],
    'and the file Vercel serves exists'
  );
  for (const r of data.runs) {
    assert.equal(r.media.videoUrl, null, 'an unplayable reel is null, never a local path');
    assert.equal(r.script.headline, `Headline ${r.id}`, 'the rest of the record is intact');
  }
});

test('a record with no media at all survives a store that is switched off', async () => {
  const file = outFile();
  await publishFeed({
    stored: { runs: [run('skipped', { video: false })] },
    outFile: file,
    canUpload: false
  });

  assert.equal(readBack(file).runs[0].media, null);
});

test('a reel already in the store keeps its URL when uploads are unavailable', async () => {
  // The whole point of readPublishedUrls: the previous publish is the only record
  // of what was uploaded. Losing that on a token outage would break reels that
  // are working perfectly well.
  const file = outFile();
  const known = new Map([['a', 'https://store.example/reels/a.mp4']]);
  await publishFeed({ stored: { runs: [run('a')] }, knownUrls: known, outFile: file, canUpload: false });

  assert.equal(readBack(file).runs[0].media.videoUrl, 'https://store.example/reels/a.mp4');
});

test('no Blob URL ever reaches the feed as a local /media path', async () => {
  // Vercel does not serve /media, so a relative path here is a 404 in the
  // <video> tag while the run log still looks perfectly healthy.
  const file = outFile();
  await publishFeed({ stored: { runs: [run('a')] }, outFile: file, canUpload: false });

  for (const r of readBack(file).runs) {
    assert.ok(!String(r.media.videoUrl).startsWith('/'), 'a local path must never be published');
  }
});

test('the build machine\'s own paths are not published', async () => {
  // The feed is a public file. media.image.file is the absolute path to the
  // downloaded background on whichever machine rendered the reel — from CI that
  // is /home/runner/work/<repo>/..., which names the build environment to anyone
  // who opens the dashboard. The attribution beside it is worth keeping; the
  // path is not.
  const file = outFile();
  await publishFeed({
    stored: {
      runs: [
        {
          ...run('a'),
          media: {
            videoUrl: '/media/a.mp4',
            durationSeconds: 15,
            image: {
              file: '/home/runner/work/Swift-check-ai/output/a/work/background.jpg',
              query: 'large cargo ship water',
              source: 'pexels',
              photographer: 'Faruk Tokluoglu',
              sourcePage: 'https://www.pexels.com/photo/10452701/'
            }
          }
        }
      ]
    },
    outFile: file,
    canUpload: false
  });

  const image = readBack(file).runs[0].media.image;
  assert.equal(image.file, undefined, 'the absolute build path is stripped');
  assert.equal(image.photographer, 'Faruk Tokluoglu', 'the attribution survives');
  assert.equal(image.sourcePage, 'https://www.pexels.com/photo/10452701/');
});

test('a record with no image block is passed through untouched', async () => {
  const file = outFile();
  await publishFeed({ stored: { runs: [run('a')] }, outFile: file, canUpload: false });

  const media = readBack(file).runs[0].media;
  assert.equal(media.image, undefined, 'no image key is invented');
  assert.equal(media.durationSeconds, 15, 'the rest of media is intact');
});
