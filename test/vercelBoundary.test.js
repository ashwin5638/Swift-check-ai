/**
 * The Vercel control plane's one hard invariant.
 *
 * `api/` runs on a read-only filesystem. `server/config.js` resolves
 * `dataDir` at import time and `dotenv.config()` writes to disk, so a single
 * transitive import of it from a function turns every route into a 500 at
 * cold start — with no stack trace pointing at the real culprit, because the
 * failure happens while the module graph is being built, not in a handler.
 *
 * These tests fail at build time instead, which is the only moment the fix is
 * cheap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../server/config.js';

const ROOT = config.paths.root;
const API = path.join(ROOT, 'api');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const apiFiles = walk(API);

/** Every module reachable from an entry point, by import specifier only. */
function importedFrom(file) {
  const src = fs.readFileSync(file, 'utf8');
  const specs = [
    ...src.matchAll(/(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g),
    ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  return specs.filter((s) => s.startsWith('.'));
}

/**
 * The modules that touch the filesystem the function does not have. `config.js`
 * is the main one; the pipeline pulls it in by way of nearly everything.
 */
const FORBIDDEN = [
  'server/config.js',
  'server/index.js',
  'server/orchestrator.js',
  'server/lib/publishRun.js',
  'server/lib/runStore.js',
  'server/lib/telegram.js',
  'server/lib/publisher.js',
];

/** The shared read models the functions are allowed — and expected — to use. */
const ALLOWED = ['server/lib/dashboard.js', 'server/lib/captions.js'];

test('api/ has entry points to check', () => {
  assert.ok(apiFiles.length >= 10, `expected the ten function entry points, found ${apiFiles.length}`);
});

/**
 * The Hobby cap, checked the way Vercel counts.
 *
 * Vercel turns every file under api/ into its own Function and fails the build
 * above twelve on Hobby. This shipped as a build error once already: a shared
 * module sat at api/lib/ instead of api/_lib/, and ten routes plus three lib
 * files is thirteen. The rename fixed the deployment, but nothing in the suite
 * noticed the count at all, so the same mistake was one `git mv` away again.
 *
 * The exclusions mirror Vercel's own filters rather than a guess at them.
 * Anything whose path contains a `/_` or `/.` segment, or ends in `.d.ts`, is
 * not a Function — which is the entire reason the shared modules carry an
 * underscore, and the reason `checkUnusedFunctions()` will not fail on a glob
 * that matches only helpers.
 */
const FUNCTION_EXTS = /\.(?:m|c)?js|tsx?|\.go|\.py|\.rb|\.rs$/;
const HOBBY_FUNCTION_LIMIT = 12;

function isVercelFunction(relPath) {
  if (relPath.includes('/.') || relPath.includes('/_') || relPath.includes('/node_modules/')) return false;
  if (relPath.endsWith('.d.ts')) return false;
  return FUNCTION_EXTS.test(relPath);
}

test('api/ stays inside the Hobby limit of twelve Functions', () => {
  const functions = apiFiles.map(rel).filter(isVercelFunction);
  assert.ok(
    functions.length <= HOBBY_FUNCTION_LIMIT,
    `api/ would deploy ${functions.length} Functions, over the Hobby limit of ${HOBBY_FUNCTION_LIMIT}:\n` +
      `  ${functions.join('\n  ')}\n` +
      '  Move anything that is not a route into an underscore-prefixed file or\n' +
      '  directory, or fold the route into an existing one.'
  );
});

test('shared api modules keep the underscore that hides them', () => {
  // The specific regression, named. `api/lib/` counted as three endpoints and
  // also exposed /api/lib/auth publicly, so this asserts the directory name
  // rather than trusting the count above to catch it.
  const shared = fs.existsSync(path.join(API, 'lib')) && fs.readdirSync(path.join(API, 'lib')).some((f) => f.endsWith('.js'));
  assert.equal(shared, false, 'api/lib/ is back; it must be api/_lib/ to stay out of the Function count');
  assert.ok(fs.existsSync(path.join(API, '_lib')), 'api/_lib/ is missing');
});

for (const file of apiFiles) {
  test(`${rel(file)} does not reach the filesystem-bound modules`, () => {
    // Walked transitively, since the point is that nobody has to notice the
    // import to be bitten by it.
    const seen = new Set();
    const bad = [];
    const walkGraph = (at) => {
      if (seen.has(at)) return;
      seen.add(at);
      for (const spec of importedFrom(at)) {
        const resolved = path.resolve(path.dirname(at), spec);
        if (!fs.existsSync(resolved)) continue;
        const target = rel(resolved);
        if (FORBIDDEN.includes(target)) bad.push(target);
        else if (ALLOWED.includes(target)) continue;
        else if (target.startsWith('api/')) walkGraph(resolved);
      }
    };
    walkGraph(file);
    assert.deepEqual([...new Set(bad)], [], 'imports something that needs a writable disk');
  });
}

test('every relative import in api/ resolves to a file that exists', () => {
  // The walk above structurally cannot catch a mistyped path: `existsSync` is
  // false for the wrong target, so the specifier is skipped over and the module
  // graph is never followed. That is how approve, reject and publish shipped
  // with `../../../_app.js` — one level too far, pointing at the repo root —
  // and passed CI while 500-ing on every click. The build stays green because
  // Vercel only discovers it when the function is invoked.
  const missing = [];
  for (const file of apiFiles) {
    for (const spec of importedFrom(file)) {
      if (!fs.existsSync(path.resolve(path.dirname(file), spec))) {
        missing.push(`${rel(file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'imports a relative path that does not exist');
});

test('the functions share their read models instead of reimplementing them', () => {
  const app = fs.readFileSync(path.join(API, '_app.js'), 'utf8');
  assert.match(app, /server\/lib\/dashboard\.js/);
  // If summariseRun is ever re-inlined here, the console and the published feed
  // can disagree about what "partial" means, and they will.
  assert.doesNotMatch(app, /function summariseRun/);
});

test('the control plane reports null credentials rather than a map of false', () => {
  const app = fs.readFileSync(path.join(API, '_app.js'), 'utf8');
  // Eleven falses reads as "broken deployment" to an operator. The keys are in
  // CI secrets and absent here, which is a fact worth stating outright.
  assert.match(app, /credentials: null/);
});
