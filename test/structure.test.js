import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../server/config.js';

// The repo used to have `src/` for the server and `dashboard/` for the client,
// which meant two directories called `src` and a path like `src/styles.css` that
// could not be resolved without knowing which one was meant. The folders are now
// `server/` and `client/`. These tests fail if that clarity is undone, because
// nothing else catches a stale path: the server resolves its own paths from
// `__dirname` and simply renders a missing logo at the end of a paid run.

const ROOT = config.paths.root;
const SERVER = path.join(ROOT, 'server');
const CLIENT = path.join(ROOT, 'client');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test', 'coverage']);
const TEXT_EXT = new Set(['.js', '.jsx', '.json', '.yml', '.yaml', '.md', '.html', '.css']);

/** Every text file under `dir`, skipping build output and dependencies. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (TEXT_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const serverFiles = walk(SERVER);
const clientFiles = walk(CLIENT);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

// ---- the split exists at all --------------------------------------------

test('server/ and client/ are separate roots with their own manifests', () => {
  assert.ok(fs.existsSync(path.join(SERVER, 'index.js')), 'server/index.js is the API entry');
  assert.ok(fs.existsSync(path.join(SERVER, 'orchestrator.js')));
  assert.ok(fs.existsSync(path.join(CLIENT, 'package.json')));
  assert.ok(fs.existsSync(path.join(CLIENT, 'index.html')));
});

test('the old folder names are gone from the repo root', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src')), false, 'src/ should have become server/');
  assert.equal(fs.existsSync(path.join(ROOT, 'dashboard')), false, 'dashboard/ should have become client/');
});

test('the client is a real sub-project, not part of the server', () => {
  const clientPkg = JSON.parse(fs.readFileSync(path.join(CLIENT, 'package.json'), 'utf8'));
  const serverPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.notEqual(clientPkg.name, serverPkg.name);
  assert.ok(clientPkg.dependencies.react, 'client owns React');
  assert.equal(serverPkg.dependencies.react, undefined, 'the server must not depend on React');
});

// ---- nothing crosses the boundary ---------------------------------------

/** Relative specifiers in `file`, resolved to absolute paths. Bare specifiers
 *  (`react`, `node:fs`) are dependencies, not a boundary crossing. A `../` hop
 *  is not automatically an escape — `client/src/lib/x` is legitimately imported
 *  as `../lib/x` — so each one is resolved and checked against its own root. */
function escapesRoot(files, root) {
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        offenders.push(`${rel(file)} -> ${spec}`);
      }
    }
  }
  return offenders;
}

test('the server never imports from client/', () => {
  assert.deepEqual(escapesRoot(serverFiles, SERVER), []);
});

test('the client never imports from server/', () => {
  assert.deepEqual(escapesRoot(clientFiles, CLIENT), []);
});

// ---- no stale path survives a rename ------------------------------------

/** Files whose job is to hold a path, so a stale one is a real bug there. */
const PATH_HOLDERS = [
  ...walk(ROOT).filter((f) => !rel(f).startsWith('client/node_modules')),
  path.join(ROOT, '.github', 'workflows', 'dailyReel.yml'),
  path.join(ROOT, '.env.example')
];

test('no file still points at a dashboard/ or src/ path', () => {
  // A directory tree writes its paths relative to the parent it has already
  // named (`client/` then `src/styles/`), so tree-drawing lines are exempt.
  // A real path in prose or a shell example is not, which is what this catches:
  // the stale `node src/orchestrator.js` and `src/templates/frame.html` that
  // the folder rename would otherwise have left behind.
  const TREE_LINE = /[\u2500-\u257F]|[|`][-+\\ ]/;
  const stale = [];
  for (const file of PATH_HOLDERS) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      if (TREE_LINE.test(line)) continue;
      if (/(^|[\s"'`(])(src|dashboard)\//.test(line) && !/client\/src\//.test(line)) {
        stale.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(stale, [], `stale folder references:\n  ${stale.join('\n  ')}`);
});

test('the server resolves its own asset paths from its own directory', () => {
  // Guards the specific bug this rename could have caused: a path built from
  // ROOT plus a hardcoded folder name, which resolves fine until it does not.
  assert.equal(config.paths.assets, path.join(SERVER, 'assets'));
  assert.equal(config.paths.templates, path.join(SERVER, 'templates'));
  assert.ok(fs.existsSync(config.paths.assets), 'assets/ must exist');
  assert.ok(fs.existsSync(path.join(config.paths.templates, 'frame.html')), 'frame.html must exist');
});

test('the configured logo resolves to a real file', () => {
  // config.json stores the logo relative to the repo root, so a rename that
  // misses this only surfaces at frame-render time.
  const logo = path.join(ROOT, config.brand.logo);
  assert.ok(fs.existsSync(logo), `logo not found at ${config.brand.logo}`);
});
