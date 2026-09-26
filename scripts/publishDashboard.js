import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { put, del } from '@vercel/blob';
import { config } from '../server/config.js';

/**
 * Publishes the run history as static data for the read-only Vercel dashboard.
 *
 * The Vercel deployment serves `client/` as a plain static site, so it cannot
 * answer `/api/runs` or stream `/media/*.mp4`. This script bridges that gap from
 * CI, where the pipeline has just written both:
 *
 *   1. copy the run history to client/public/data/runs.json, which the Vite
 *      build copies into dist/ and Vercel then serves as a static asset
 *   2. rewrite each reel's URL from the local /media/<id>.mp4 to its Vercel Blob
 *      URL, so the <video> element in the dashboard can seek
 *   3. prune, because Hobby Blob allows 1 GB of storage and then hard-stops:
 *      exceeding it does not bill, it locks Blob until the month rolls over
 *
 * state/runs.json is left untouched. It keeps /media/<id>.mp4 because that is
 * the path Express serves, and mixing the two would break `npm run dev`.
 */

// 8.34 MB per 15s 1080x1920 reel, so five is ~42 MB against a 1 GB allowance.
export const MAX_VIDEOS = 5;
// ~3.1 KB per record, so thirty is ~95 KB — cheap to keep, and it means the run
// log stays useful long after the reels themselves have been pruned away.
export const MAX_RECORDS = 30;

const BLOB_PREFIX = 'reels';
const OUT_FILE = path.join(config.paths.root, 'client', 'public', 'data', 'runs.json');

/**
 * Blob URLs of the reels currently in the store, keyed by run id.
 *
 * The previously published file is the only record of what was uploaded: the
 * mp4s live in `output/`, which is gitignored and does not survive a CI
 * checkout, and the SDK keeps no local index. So a run whose reel is still
 * inside the window but whose file is long gone keeps its existing URL instead
 * of being nulled out.
 */
export function readPublishedUrls(file = OUT_FILE) {
  let published;
  try {
    published = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }

  const urls = new Map();
  for (const run of published.runs ?? []) {
    const url = run?.media?.videoUrl;
    // state/runs.json holds the relative /media/<id>.mp4; only an absolute URL
    // here means this reel was already uploaded to Blob.
    if (run?.id && typeof url === 'string' && url.startsWith('https://')) {
      urls.set(run.id, url);
    }
  }
  return urls;
}

/**
 * Decides which records ship and which of them keep a playable reel. Pure, so
 * the retention rules — the part that silently loses data if it drifts — can be
 * tested without a Blob store.
 *
 * Records and videos are capped separately on purpose: a run log that outlives
 * its own footage is still worth reading, so thirty records survive while only
 * the newest five reels stay downloadable.
 */
export function selectPublishable(runs, { maxRecords = MAX_RECORDS, maxVideos = MAX_VIDEOS } = {}) {
  // state.js unshifts, so index 0 is the newest run.
  const records = runs.slice(0, maxRecords);
  const videoIds = new Set(
    records.filter((r) => r.media?.videoUrl).slice(0, maxVideos).map((r) => r.id)
  );
  return { records, videoIds };
}

/** The existing URL if we have one, otherwise upload the file from output/. */
async function resolveVideoUrl(run, knownUrls) {
  const known = knownUrls.get(run.id);
  if (known) return known;

  const file = path.join(config.paths.output, `${run.id}.mp4`);
  if (!fs.existsSync(file)) {
    console.warn(`  ! ${run.id}  no file in output/ and no published URL — reel unavailable`);
    return null;
  }

  // Deterministic path plus overwrite: if client/public/data were ever lost while
  // state/ survived, this re-uploads to the same pathname and heals the gap
  // rather than orphaning the original blob.
  const blob = await put(`${BLOB_PREFIX}/${run.id}.mp4`, fs.readFileSync(file), {
    access: 'public',
    contentType: 'video/mp4',
    addRandomSuffix: false,
    allowOverwrite: true
  });
  console.log(`  up ${run.id}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB -> Blob`);
  return blob.url;
}

export async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set. Use a long-lived Vercel token, not the ' +
        "project's OIDC vars — this runs in CI, outside Vercel. Create one with " +
        '`vercel blob token create` and add it as a repository secret.'
    );
  }

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(config.paths.runs, 'utf8'));
  } catch {
    throw new Error(`Could not read ${config.paths.runs} — has the pipeline run yet?`);
  }

  const knownUrls = readPublishedUrls();
  const { records, videoIds } = selectPublishable(
    Array.isArray(stored.runs) ? stored.runs : []
  );

  const published = [];
  for (const run of records) {
    if (!run.media) {
      published.push(run);
      continue;
    }
    const media = { ...run.media };
    media.videoUrl = videoIds.has(run.id) ? await resolveVideoUrl(run, knownUrls) : null;
    published.push({ ...run, media });
  }

  // Whatever the previous publish left in Blob that this one no longer references
  // has fallen out of the retention window. del() is free, so this is pure gain.
  const live = new Set(published.map((r) => r.media?.videoUrl).filter(Boolean));
  const stale = [...new Set(knownUrls.values())].filter((url) => !live.has(url));
  for (const url of stale) await del(url);
  if (stale.length) {
    console.log(`  down pruned ${stale.length} reel(s) past the ${MAX_VIDEOS}-reel window`);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), runs: published }, null, 2)}\n`,
    'utf8'
  );

  const playable = published.filter((r) => r.media?.videoUrl).length;
  console.log(
    `\n+ ${published.length} run record(s), ${playable} playable reel(s) -> client/public/data/runs.json`
  );
}

// Same guard as server/orchestrator.js: a bare pathToFileURL comparison, so
// importing this module from the test suite does not kick off an upload.
const isMain = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

if (isMain) {
  main().catch((err) => {
    console.error(`\nx ${err.message}`);
    process.exit(1);
  });
}
