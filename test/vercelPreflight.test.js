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
