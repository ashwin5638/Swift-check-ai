import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { check } from '../scripts/vercelPreflight.js';
import { config } from '../server/config.js';

const ROOT = config.paths.root;

/** A throwaway directory laid out like the real project. */
function scaffold({ api = true, client = true, vercel = true, locks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  if (locks) fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  if (api) {
    fs.mkdirSync(path.join(dir, 'api'));
    fs.writeFileSync(path.join(dir, 'api', '_app.js'), '');
  }
  if (client) {
    fs.mkdirSync(path.join(dir, 'client'));
    fs.writeFileSync(path.join(dir, 'client', 'package.json'), '{}');
  }
  if (vercel) fs.writeFileSync(path.join(dir, 'vercel.json'), '{}');
  return dir;
}

test('the real repository passes its own preflight', () => {
  const { problems, notes } = check(ROOT);
  assert.deepEqual(problems, [], 'the deploy would fail its own preflight');
  assert.ok(notes.length, 'should confirm the Root Directory looks right');
});

test('a Root Directory of client/ is reported as the dashboard mistake', () => {
  // The layout Vercel sees when the project's Root Directory is set to client/:
  // cwd is the client, so the install resolves there instead of the repository
  // and npm claims there is no lockfile. Nothing in the repo reveals this, which
  // is the whole reason the preflight exists.
  const dir = scaffold({ api: false, client: false });
  fs.writeFileSync(path.join(dir, 'vite.config.js'), '');

  const { problems } = check(dir);
  const rootDir = problems.find((p) => /Root Directory/.test(p));
  assert.ok(rootDir, `expected the dashboard diagnosis, got: ${problems.join(' | ')}`);
  assert.match(rootDir, /Settings -> General/);
  assert.match(rootDir, /repository root/);
  assert.match(rootDir, /api\/ is outside the project/);
  // It must not tell someone to commit a lockfile that is already committed.
  assert.doesNotMatch(problems.join('\n'), /npm install/);
});

test('a missing lockfile is still reported when that is genuinely the fault', () => {
  const dir = scaffold({ locks: false });
  const { problems } = check(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /package-lock\.json is missing from the working directory/);
});

test('a missing client/package.json is reported separately from the lockfile', () => {
  // The client is a workspace now, so this is the file that must be in scope for
  // the build to produce anything, and the only lockfile is the root one.
  const dir = scaffold({ client: false });
  const { problems } = check(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /client\/package\.json is missing/);
});

test('an api/ without a route table is caught before it deploys nothing', () => {
  const dir = scaffold();
  fs.rmSync(path.join(dir, 'api', '_app.js'));
  const { problems } = check(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /_app\.js is missing/);
});

test('an api/ over the Hobby limit is reported by name', () => {
  // The exact build this guards: thirteen Files under api/, which Vercel refuses
  // with one sentence that names no file and suggests no fix.
  const dir = scaffold();
  for (let i = 0; i < 13; i++) fs.writeFileSync(path.join(dir, 'api', `route${i}.js`), '');

  const { problems } = check(dir);
  const over = problems.find((p) => /Hobby limit of 12/.test(p));
  assert.ok(over, `expected the Function-count diagnosis, got: ${problems.join(' | ')}`);
  // It has to be actionable, so the files and the remedy both have to be in it.
  assert.match(over, /api\/route0\.js/);
  assert.match(over, /api\/route12\.js/);
  assert.match(over, /underscore/);
});

test('an underscore-prefixed module is not counted against the limit', () => {
  // The fix for the above, and the convention api/_lib/ already follows. If the
  // count included these, the preflight would report a deployment that Vercel
  // builds happily, and the operator would be sent chasing a non-problem.
  const dir = scaffold();
  fs.mkdirSync(path.join(dir, 'api', '_lib'));
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, 'api', `route${i}.js`), '');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, 'api', '_lib', `shared${i}.js`), '');

  const { problems, notes } = check(dir);
  assert.deepEqual(problems, [], 'helpers behind an underscore must not count');
  assert.ok(
    notes.some((n) => /deploys 12 Function/.test(n)),
    `expected a note counting 12 Functions, got: ${notes.join(' | ')}`
  );
});

test('a nested helper is excluded too, not just a top-level one', () => {
  // Vercel filters on the whole path containing /_ , so api/runs/_util.js is
  // hidden from the count exactly as api/_lib/auth.js is.
  const dir = scaffold();
  fs.mkdirSync(path.join(dir, 'api', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api', 'runs', '_util.js'), '');
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, 'api', `route${i}.js`), '');

  assert.deepEqual(check(dir).problems, []);
});

test('the real api/ is inside the limit', () => {
  // The count is asserted against the live tree, so this fails the moment a
  // thirteenth entry point appears rather than on the next deploy.
  const { notes } = check(ROOT);
  assert.ok(
    notes.some((n) => /within the Hobby limit of 12/.test(n)),
    `expected the Function count to be reported as within the limit, got: ${notes.join(' | ')}`
  );
});
