/**
 * Vercel runs `installCommand` and `buildCommand` with the working directory
 * set to the project's **Root Directory** setting, not to the repository root.
 * When those differ, nothing in the repo can tell: the install lands in the wrong
 * directory, npm reports that no lockfile exists, and the lockfile is sitting in
 * git the whole time. That loop is expensive, so this runs from buildCommand —
 * which Vercel documents as overridable, unlike the install command when an
 * `api/` directory is present — and says which field to clear.
 *
 * It also checks the files the build genuinely needs are in scope, which is the
 * one part of the original report that was right, just aimed at the wrong path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT_HINT =
  'Vercel -> your project -> Settings -> General -> Root Directory -> clear the field (it must be the repository root) -> Save, then redeploy.';

/** Hobby allows twelve Functions per deployment; the count is checked, not assumed. */
const HOBBY_FUNCTION_LIMIT = 12;;

/**
 * @param {string} cwd working directory Vercel would use
 * @returns {{ problems: string[], notes: string[] }}
 */
export function check(cwd) {
  const problems = [];
  const notes = [];

  const has = (p) => fs.existsSync(path.resolve(cwd, p));
  const isFile = (p) => {
    try {
      return fs.statSync(path.resolve(cwd, p)).isFile();
    } catch {
      return false;
    }
  };

  // The one that matters. api/ holds the Functions, so if it is not inside the
  // project there is no serverless API to deploy, whatever the build reports.
  if (!has('api')) {
    const looksLikeClient = has('vite.config.js') || has('client');
    problems.push(
      looksLikeClient
        ? `Root Directory is "${path.basename(cwd)}", not the repository root.\n` +
          `  api/ is outside the project, so no Vercel Functions can be built, and the\n` +
          `  install there runs against ${path.basename(cwd)}/ rather than the repository,\n` +
          `  which is why npm reports that package-lock.json is missing.\n` +
          `  There is one lockfile, at the repository root, and it is committed.\n` +
          `  Fix: ${ROOT_HINT}`
        : `api/ is not present under the working directory "${cwd}".\n` +
          `  It must be inside the project for the Functions to be built. Fix: ${ROOT_HINT}`
    );
  } else if (!isFile('api/_app.js')) {
    problems.push('api/ exists but api/_app.js is missing, so no route table would be deployed.');
  }

  // client/ is an npm workspace, so there is deliberately no client/package-lock.json.
  // Its dependencies resolve from the single root lockfile.
  if (!isFile('package-lock.json')) {
    problems.push(
      'package-lock.json is missing from the working directory, so `npm ci` cannot run.\n' +
        '  It is committed at the repository root; if this is correct, the Root Directory\n' +
        '  is pointing somewhere it should not.'
    );
  }

  if (!isFile('client/package.json')) {
    problems.push(
      'client/package.json is missing, so the client workspace cannot be built.\n' +
        '  It is committed in git; if it is genuinely absent, the deploy is not building\n' +
        '  the current commit, or something is excluding it (.vercelignore).'
    );
  }

  if (has('api') && has('client') && isFile('vercel.json')) {
    notes.push('Root Directory looks correct: api/, client/ and vercel.json are all in scope.');
  }

  // Vercel fails the build above twelve Functions on Hobby with one sentence
  // that names neither the files nor the fix, so the count is checked here
  // instead, where the message can list both. The exclusions are Vercel's: a
  // path with a `/_` or `/.` segment, or a .d.ts, is not a Function.
  if (has('api')) {
    const functions = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.resolve(cwd, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (rel.includes('/_') || rel.includes('/.') || rel.endsWith('.d.ts')) continue;
        else if (/\.(?:m|c)?js|tsx?|\.go|\.py|\.rb|\.rs$/.test(entry.name)) functions.push(rel);
      }
    };
    walk('api');

    if (functions.length > HOBBY_FUNCTION_LIMIT) {
      problems.push(
        `api/ would deploy ${functions.length} Vercel Functions, over the Hobby limit of ${HOBBY_FUNCTION_LIMIT}.\n` +
          `  Vercel turns every file under api/ into its own Function, and it would\n` +
          `  stop the build with "No more than 12 Serverless Functions" without saying which.\n` +
          `  These are the ${functions.length}:\n` +
          functions.map((f) => `    ${f}\n`).join('') +
          '  Anything that is not a route belongs in an underscore-prefixed file or\n' +
          '  directory — api/_lib/ is already the convention — or folded into a route\n' +
          '  that already exists.'
      );
    } else {
      notes.push(`api/ deploys ${functions.length} Function(s), within the Hobby limit of ${HOBBY_FUNCTION_LIMIT}.`);
    }
  }

  return { problems, notes };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { problems, notes } = check(process.cwd());

  for (const note of notes) console.log(`  ok  ${note}`);
  if (problems.length) {
    console.error('\nVercel preflight failed:\n');
    for (const problem of problems) console.error(`  x  ${problem}`);
    console.error('');
    process.exit(1);
  }
  console.log('  ok  the single root lockfile covers the root and the client workspace');
}
