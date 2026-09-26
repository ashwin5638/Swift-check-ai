import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../server/config.js';
import { captionFor } from '../client/src/lib/feed.js';

/**
 * The published feed and the dashboard are two halves of one contract, and
 * nothing checks it at compile time: the feed is JSON written by CI, the
 * dashboard is a browser bundle, and a field that goes missing fails as a blank
 * panel rather than an error.
 *
 * These tests pin both directions — that a published record still carries what
 * the components read, and that the read-only caption matches the file the
 * publisher would have uploaded.
 */

/** What the dashboard reads off a run, component by component. */
const FIELDS_THE_CLIENT_READS = [
  'id',            // RunLog key, RunDetail header
  'startedAt',     // RunLog, RunDetail
  'finishedAt',    // summariseRuns(): only settled runs count toward pass rate
  'durationMs',    // KpiStrip, RunLog bar, StageWaterfall
  'status',        // RunLog dot, displayStatus()
  'dry',           // RunDetail and StageWaterfall badges
  'event',         // RunDetail title, reason, source, url
  'script',        // RunDetail voiceover and both captions
  'media',         // RunDetail <video> and the spec grid
  'beats',         // RunDetail beat list
  'steps',         // StageWaterfall gantt
  'llm',           // KpiStrip token totals, StageWaterfall footer
  'publish'        // displayStatus() and the results table
];

/**
 * Only present on some records, and read only in the branch that implies it.
 * The API's summarise() flattens `error` to null; the raw record omits it, so
 * asserting it as required would be wrong rather than strict. Covered by its own
 * test below.
 */

function loadRealRuns() {
  const raw = fs.readFileSync(config.paths.runs, 'utf8');
  return JSON.parse(raw).runs ?? [];
}

test('state/runs.json records carry every field the dashboard reads', () => {
  const runs = loadRealRuns();
  assert.ok(runs.length, `no run records in ${config.paths.runs} — run the pipeline first`);

  for (const run of runs) {
    for (const field of FIELDS_THE_CLIENT_READS) {
      assert.ok(
        field in run,
        `run ${run.id} is missing "${field}", which the published feed would also be missing`
      );
    }
  }
});

test('error is present exactly when a run failed', () => {
  // RunDetail renders run.error inside the `status === 'failed'` branch, so the
  // invariant is that the two agree, not that the field always exists.
  for (const run of loadRealRuns()) {
    assert.equal(
      'error' in run,
      run.status === 'failed',
      `run ${run.id} (${run.status}) disagrees about whether it recorded an error`
    );
  }
});

test('media is null rather than absent when the render was skipped', () => {
  // The dashboard branches on media.skipped and on media.videoUrl, both of which
  // need the key to be there. `media: null` is the skipped shape; the key
  // vanishing would read as a malformed record instead.
  for (const run of loadRealRuns()) {
    assert.ok('media' in run, `run ${run.id} has no media key at all`);
  }
});

test('a run record has no flattened title, so the run log must read event.title', () => {
  // /api/runs flattens event.title to `title`; the published feed ships the raw
  // record. A component reading only `r.title` renders "No story selected" for
  // every run in read-only mode, which is a silent blank rather than a crash.
  const [run] = loadRealRuns();
  assert.ok(run.event?.title, 'the record should carry event.title');
  assert.equal(run.title, undefined, 'the raw record must not be expected to have a top-level title');
});

test('the story title survives to the top of the run log in both shapes', () => {
  const [record] = loadRealRuns();
  const expected = record.event.title;

  // What the API returns (server/index.js summarise()).
  const apiShape = { ...record, title: record.event.title };
  delete apiShape.event;

  // What each consumer resolves, mirroring RunLog's expression.
  const fromRecord = record.event?.title ?? record.title;
  const fromApi = apiShape.event?.title ?? apiShape.title;

  assert.equal(fromRecord, expected, 'read-only mode resolves the title');
  assert.equal(fromApi, expected, 'live mode still resolves the title');
});

test('the read-only caption is byte-identical to the file the publisher uploads', () => {
  // orchestrator.js captionFile() is what writes output/<id>/<platform>.txt and
  // what the publisher sends. If captionFor() drifts, the copy button hands the
  // operator something they did not approve.
  const [run] = loadRealRuns();
  if (!run.script?.facebookCaption) return; // a --no-render run has no script

  // A faithful copy of orchestrator.js captionFile(), which is what writes
  // output/<id>/<platform>.txt. The join matters: hashtags is stored as an array,
  // and letting it stringify would hand the operator comma-separated tags.
  const expected = (body, hashtags, url) =>
    [body, hashtags?.join(' '), url].filter(Boolean).join('\n\n') + '\n';

  assert.equal(
    captionFor(run, 'facebook'),
    expected(run.script.facebookCaption, run.script.hashtags, run.event.url)
  );
  assert.equal(
    captionFor(run, 'linkedin'),
    expected(run.script.linkedinCaption, run.script.hashtags, run.event.url)
  );
});

test('a caption with no hashtags or source url does not gain stray blank lines', () => {
  const run = { event: {}, script: { facebookCaption: 'Just the caption.' } };
  assert.equal(captionFor(run, 'facebook'), 'Just the caption.\n');
  assert.equal(captionFor({}, 'linkedin'), '\n', 'an absent caption is not invented');
});

test('the published feed path is the one Vite serves from public/', () => {
  // client/public/* is copied verbatim into dist/, so this file becomes
  // /data/runs.json. A move out of public/ silently 404s the whole dashboard.
  const feed = path.join(config.paths.root, 'client', 'public', 'data', 'runs.json');
  assert.ok(
    path.join(feed, '..').startsWith(path.join(config.paths.root, 'client', 'public')),
    'the feed must live under client/public/ to be served at /data/runs.json'
  );
});
