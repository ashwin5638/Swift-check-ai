import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { deleteRun, getRun, loadRuns, runDisplayStatus } from '../server/lib/state.js';
import { config } from '../server/config.js';

// config.paths.runs points at the real state file with no env override, so the
// suite snapshots and restores it — otherwise `npm test` would wipe run history.
const FILE = config.paths.runs;
let snapshot = null;

before(() => { snapshot = fs.readFileSync(FILE, 'utf8'); });
after(() => { fs.writeFileSync(FILE, snapshot); });

/** Replaces the history with a known log, newest first, as the API stores it. */
function reset(runs) {
  const list = runs.map((id) => ({ id, startedAt: '2026-01-01T00:00:00.000Z', status: 'skipped' }));
  fs.writeFileSync(FILE, `${JSON.stringify({ runs: list }, null, 2)}\n`, 'utf8');
}

test('removes only the targeted run', () => {
  reset(['run-c', 'run-b', 'run-a']);
  assert.equal(deleteRun('run-b'), true);
  assert.deepEqual(loadRuns().map((r) => r.id), ['run-c', 'run-a']);
  assert.equal(getRun('run-b'), null);
});

test('leaves the newest-first order of the survivors intact', () => {
  reset(['run-4', 'run-3', 'run-2', 'run-1']);
  deleteRun('run-2');
  assert.deepEqual(loadRuns().map((r) => r.id), ['run-4', 'run-3', 'run-1']);
});

test('reports false for an id that is not in the log and changes nothing', () => {
  reset(['run-a']);
  const before_ = fs.readFileSync(FILE, 'utf8');
  assert.equal(deleteRun('missing'), false);
  assert.equal(fs.readFileSync(FILE, 'utf8'), before_);
});

test('getRun returns the full record for a known id', () => {
  fs.writeFileSync(FILE, `${JSON.stringify({ runs: [{ id: 'run-a', title: 'Hormuz volumes surge' }] }, null, 2)}\n`, 'utf8');
  assert.equal(getRun('run-a').title, 'Hormuz volumes surge');
});

test('a corrupt state file degrades to false instead of throwing', () => {
  fs.writeFileSync(FILE, '{ not json', 'utf8');
  assert.equal(deleteRun('run-a'), false);
  assert.deepEqual(loadRuns(), []);
});

// ---- display status -----------------------------------------------------
// A run that reached a platform must not still read "skipped": the pipeline
// writes status before publishing happens, so the stored value is stale by the
// time anyone looks at the dashboard.

test('a published run shows published, not the pipeline status', () => {
  assert.equal(
    runDisplayStatus({ status: 'skipped', publish: { status: 'published' } }),
    'published'
  );
  assert.equal(
    runDisplayStatus({ status: 'dry-run', publish: { status: 'published' } }),
    'published'
  );
});

test('a partial publish is visible as partial', () => {
  assert.equal(
    runDisplayStatus({ status: 'skipped', publish: { status: 'partial' } }),
    'partial'
  );
});

test('a queued run awaiting approval keeps that status', () => {
  assert.equal(
    runDisplayStatus({ status: 'skipped', publish: { status: 'awaiting-approval' } }),
    'awaiting-approval'
  );
});

test('a genuine pipeline failure is never masked by publish state', () => {
  assert.equal(
    runDisplayStatus({ status: 'failed', publish: { status: 'skipped' } }),
    'failed'
  );
});

test('a failed publish does not overwrite a healthy run status', () => {
  assert.equal(
    runDisplayStatus({ status: 'awaiting-approval', publish: { status: 'failed' } }),
    'awaiting-approval'
  );
});

test('a run with no publish record falls back to its own status', () => {
  assert.equal(runDisplayStatus({ status: 'running' }), 'running');
  assert.equal(runDisplayStatus({}), 'unknown');
});
