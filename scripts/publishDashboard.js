import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { get, put, del } from '@vercel/blob';
import { config } from '../server/config.js';
import {
  PATHS,
  applyPendingTombstones,
  applyTombstones,
  emptyTombstones
} from '../api/lib/blobState.js';

/**
 * Publishes run state for the Vercel deployment, in two shapes.
 *
 * The Vercel project is a static site plus a control plane: the Vite build
 * serves client/dist, and api/ serves /api/* from Vercel Blob. The same CI step
 * feeds both, because a dashboard that can trigger a run but cannot show one is
 * worse than either half.
 *
 *   1. client/public/data/runs.json, copied into dist/ and served at
 *      /data/runs.json. This is what the console falls back to when
 *      VITE_READ_ONLY=1, and it needs no credentials.
 *   2. state/*.json in Blob, which is what api/ reads for every request. This is
 *      the live path.
 *
 * Both get the same records with the same resolved reel URLs, so the fallback and
 * the live console cannot disagree about whether a reel is playable. The URLs
 * must be Blob URLs and not /media/<id>.mp4: the Vercel function has no
 * filesystem, and a local path handed to the publish workflow as `video_url`
 * would fail to download on the runner.
 *
 * Step 1 needs no credentials and is written first, on purpose: steps 2 and 3 are
 * improvements to a dashboard that is already correct without them. A store that
 * is unreachable, or a token that was never set, costs the control plane and
 * reel playback and the exit code — never the run log. The reverse ordering once
 * made a single missing secret look like a permanently broken deployment, because
 * the client reads a 404 on runs.json as "no runs yet" and says so rather than
 * complaining.
 *
 * state/runs.json on disk is left untouched. It keeps /media/<id>.mp4 because
 * that is the path Express serves, and mixing the two would break `npm run dev`.
 *
 * ## Tombstones
 *
 * A run deleted from the console comes straight back if this script uploads CI's
 * copy unfiltered, because CI rebuilds state from its cache every run. So the ids
 * a human deleted or rejected are read back out of Blob and applied here, which
 * is what makes the delete button permanent rather than good-until-tomorrow.
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

/**
 * The existing URL if we have one, otherwise upload the file from output/.
 *
 * A missing token and a rejected upload both land where a reel that was never
 * rendered lands: the run still ships, with `videoUrl: null`. That is the whole
 * point. The feed is a 4 KB JSON file that needs no credentials, and the reels
 * are optional garnish on top of it, so an unavailable store must cost playback
 * and nothing else. An earlier version threw out of here before the feed was
 * ever written, which turned one missing credential into a permanently empty
 * dashboard — and because the workflow tolerates a failed publish, nothing said
 * so.
 */
async function resolveVideoUrl(run, knownUrls, { canUpload }) {
  const known = knownUrls.get(run.id);
  if (known) return known;
  if (!canUpload) return null;

  const file = path.join(config.paths.output, `${run.id}.mp4`);
  if (!fs.existsSync(file)) {
    console.warn(`  ! ${run.id}  no file in output/ and no published URL — reel unavailable`);
    return null;
  }

  try {
    // Deterministic path plus overwrite: if client/public/data were ever lost
    // while state/ survived, this re-uploads to the same pathname and heals the
    // gap rather than orphaning the original blob.
    const blob = await put(`${BLOB_PREFIX}/${run.id}.mp4`, fs.readFileSync(file), {
      access: 'public',
      contentType: 'video/mp4',
      addRandomSuffix: false,
      allowOverwrite: true
    });
    console.log(`  up ${run.id}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB -> Blob`);
    return blob.url;
  } catch (err) {
    // One rejected reel must not cost the other four, and must not cost the feed.
    console.warn(`  ! ${run.id}  upload failed (${err.message}) — record ships without a reel`);
    return null;
  }
}

/**
 * Assembles what should ship, then writes it. Exported for one reason: the
 * invariant that the feed reaches disk even when every reel upload has failed is
 * the whole point of this script's ordering, and an invariant nobody can test is
 * an invariant that quietly regresses.
 *
 * Reads its run history and its destination from the options, so a test can hand
 * it fixtures. Defaults are the real paths; that is every production caller.
 */
export async function publishFeed({
  stored,
  knownUrls = new Map(),
  outFile = OUT_FILE,
  canUpload = Boolean(process.env.BLOB_READ_WRITE_TOKEN)
} = {}) {
  const { records, videoIds } = selectPublishable(
    Array.isArray(stored?.runs) ? stored.runs : []
  );

  const published = [];
  for (const run of records) {
    if (!run.media) {
      published.push(run);
      continue;
    }
    const media = { ...run.media };
    // media.image.file is where the background was downloaded on whichever
    // machine rendered the reel. This feed is served publicly, so an absolute
    // build path in it names the build environment for no benefit — the client
    // never reads media.image. The attribution beside it is kept: that is the
    // whole reason the photographer is recorded.
    if (media.image?.file) {
      media.image = { ...media.image };
      delete media.image.file;
    }
    media.videoUrl = videoIds.has(run.id)
      ? await resolveVideoUrl(run, knownUrls, { canUpload })
      : null;
    published.push({ ...run, media });
  }

  // Written before the prune, and before anything else that can fail, because
  // this is the file Vercel serves at /data/runs.json. Everything below is an
  // improvement to a dashboard that already works; none of it is the dashboard.
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), runs: published }, null, 2)}\n`,
    'utf8'
  );

  return published;
}

/**
 * Drops blobs the retention window has moved past. Pure gain — del() is free —
 * and deliberately after publishFeed, because a store that is over quota refuses
 * deletes, which must not cost a dashboard that is already written.
 */
async function pruneBlobs(knownUrls, published) {
  const live = new Set(published.map((r) => r.media?.videoUrl).filter(Boolean));
  const stale = [...new Set(knownUrls.values())].filter((url) => !live.has(url));
  for (const url of stale) {
    try {
      await del(url);
    } catch (err) {
      // Skipping only means the prune finishes on a later run.
      console.warn(`  ! could not prune ${url} (${err.message})`);
    }
  }
  if (stale.length) {
    console.log(`  down pruned ${stale.length} reel(s) past the ${MAX_VIDEOS}-reel window`);
  }
}

/**
 * Reads back the deletions the console recorded.
 *
 * A failure here resolves to "no tombstones", which means this run re-uploads
 * anything that was deleted in the last day. That is the same failure shape as
 * having no store at all: the dashboard recovers on the next run, and the cost is
 * a deleted run reappearing once rather than the pipeline stopping. The opposite
 * default — refusing to publish when tombstones cannot be read — would let an
 * unreachable store block the run log, which is the thing that must always work.
 */
export async function readTombstones() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return emptyTombstones();
  try {
    const blob = await get(PATHS.tombstones, { useCache: false });
    if (!blob?.stream) return emptyTombstones();
    return { ...emptyTombstones(), ...JSON.parse(await new Response(blob.stream).text()) };
  } catch (err) {
    console.warn(`  ! could not read tombstones (${err.message}) — deletions may reappear once`);
    return emptyTombstones();
  }
}

/**
 * Writes the live state api/ serves.
 *
 * `published` is the same array written to the static feed, not the raw
 * state/runs.json — the reel URLs in it are already resolved to Blob, and
 * uploading the local /media/ paths would leave the approve button dispatching a
 * download the runner cannot perform.
 *
 * Ordered records first, then the queue. A failure partway leaves the console
 * showing runs with a stale queue rather than an empty console, which is the
 * better of the two partial states.
 */
export async function publishState({ published, pending, covered }) {
  const writes = [
    [PATHS.runs, { runs: published, generatedAt: new Date().toISOString() }],
    [PATHS.pending, { pending }],
    [PATHS.covered, { events: covered }]
  ];

  for (const [pathname, body] of writes) {
    await put(pathname, `${JSON.stringify(body, null, 2)}\n`, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true
    });
    console.log(`  state ${pathname} (${Array.isArray(body.runs) ? body.runs.length : Array.isArray(body.pending) ? body.pending.length : (body.events || []).length} record(s))`);
  }
}

export async function main() {
  // A missing token is a misconfiguration rather than an outage: no reel can be
  // published until it is set, so it is reported loudly and sets a non-zero exit
  // code below. It is not fatal, because the run log does not need a store.
  const canUpload = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  if (!canUpload) {
    console.warn(
      [
        '',
        '! BLOB_READ_WRITE_TOKEN is not set — publishing the run log with no reels.',
        '',
        '  Vercel mints this token when you create a Blob store, and there is no CLI',
        '  command that creates one. Dashboard: the project, then Storage, then',
        '  Create Database > Blob, access Public. Copy the value from the store page',
        '  into .env and into the repository secret of the same name.',
        '',
        "  Use that long-lived token, not the project's OIDC vars: this runs in CI,",
        '  outside Vercel, where OIDC is unavailable.',
        ''
      ].join('\n')
    );
  }

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(config.paths.runs, 'utf8'));
  } catch {
    throw new Error(`Could not read ${config.paths.runs} — has the pipeline run yet?`);
  }

  const tombstones = await readTombstones();
  const dropped = tombstones.runs.length + tombstones.pending.length;
  if (dropped) console.log(`  honouring ${dropped} deletion(s) recorded in the console`);

  const knownUrls = readPublishedUrls();
  const published = await publishFeed({
    stored: { runs: applyTombstones(stored.runs ?? [], tombstones) },
    knownUrls,
    canUpload
  });

  await pruneBlobs(knownUrls, published);

  // The live state api/ reads. A failure here leaves the static feed above intact
  // and already written, which is why it comes after and not before.
  if (canUpload) {
    try {
      await publishState({
        published,
        pending: applyPendingTombstones(readLocal(config.paths.pendingPosts, { pending: [] }).pending, tombstones),
        covered: readLocal(config.paths.coveredEvents, { events: [] }).events
      });
    } catch (err) {
      // The reels are on Blob and the run log is on disk; only the control plane
      // is stale, and it recovers on the next run. The workflow's
      // continue-on-error exists to absorb exactly this.
      console.warn(`  ! could not publish live state (${err.message}) — the console will read the static feed`);
    }
  }

  const playable = published.filter((r) => r.media?.videoUrl).length;
  console.log(
    `\n+ ${published.length} run record(s), ${playable} playable reel(s) -> client/public/data/runs.json`
  );

  // Non-zero so a missing token is visible in CI and to anyone running this by
  // hand, while the feed above is already written. A genuine Blob outage still
  // exits 0, because the workflow's continue-on-error exists to absorb exactly
  // that and the dashboard merely goes stale until the next run.
  if (!canUpload) process.exitCode = 1;
}

/** Missing state files are the normal case before the first run of that kind. */
function readLocal(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
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
