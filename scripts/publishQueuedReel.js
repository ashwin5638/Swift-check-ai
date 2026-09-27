import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { config } from '../server/config.js';
import { get } from '@vercel/blob';
import { getRun } from '../server/lib/state.js';
import { publishRun } from '../server/lib/publishRun.js';

/**
 * Publishes a reel that this runner did not render.
 *
 * The Vercel deployment is a control plane: approving a reel there dispatches
 * this workflow rather than posting anything itself, because Playwright and
 * ffmpeg cannot run in a serverless function. So the reel arrives as a URL —
 * publishDashboard.js put the newest five in Blob — and this fetches it, then
 * hands off to the same publishRun() the local API uses.
 *
 * The record is looked up locally first because that is the common case: the daily
 * workflow's cache step carries state/ between runs, so a reel queued yesterday is
 * on disk. The Blob fallback covers an evicted cache, and is only a fallback
 * because the cached copy is the one whose record matches the mp4 that rendered.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A run id becomes a filename here, so it gets the same allowlist as everywhere else. */
function readRunId() {
  const id = String(process.env.RUN_ID || '').trim();
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `RUN_ID is missing or malformed (${JSON.stringify(process.env.RUN_ID || null)}). ` +
        'The workflow requires run_id as a dispatch input.'
    );
  }
  return id;
}

/**
 * @param platformsCsv comma-separated, or empty for every platform config.json
 *   enables. The queue records exactly which platforms a reel was gated for, so
 *   an approval must not widen that.
 */
function readPlatforms() {
  const csv = String(process.env.PLATFORMS || '').trim();
  if (!csv) return undefined;
  const list = csv.split(',').map((p) => p.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

async function fetchReel(videoUrl, runId) {
  const target = path.join(config.paths.output, `${runId}.mp4`);
  fs.mkdirSync(config.paths.output, { recursive: true });

  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Could not download the reel: ${videoUrl} returned HTTP ${res.status}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  // An HTML error page saved as .mp4 is the failure mode worth catching: the
  // upload would otherwise fail much later with an opaque Graph error.
  if (bytes.subarray(0, 12).toString('latin1').indexOf('<!DOCTYPE') === 0 || bytes.length < 1024) {
    throw new Error(`The reel at ${videoUrl} is not an mp4 (${bytes.length} bytes) — it may have expired.`);
  }

  fs.writeFileSync(target, bytes);
  const mb = (bytes.length / 1024 / 1024).toFixed(1);
  console.log(`  fetched ${runId}.mp4 (${mb} MB)`);
  return target;
}

async function loadRecord(runId) {
  const local = await getRun(runId);
  if (local) return local;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      `Run ${runId} is not in the restored state and BLOB_READ_WRITE_TOKEN is not set, ` +
        'so there is nowhere to look for it.'
    );
  }

  const blob = await get('state/runs.json', { useCache: false });
  if (!blob?.stream) throw new Error(`Run ${runId} is not in state and state/runs.json is not in Blob.`);

  const data = JSON.parse(await new Response(blob.stream).text());
  const run = (data.runs || []).find((r) => r.id === runId);
  if (!run) throw new Error(`Run ${runId} is in neither the restored state nor Blob.`);
  console.log(`  record ${runId} recovered from Blob`);
  return run;
}

export async function main() {
  const runId = readRunId();
  const dry = process.env.DRY === 'true';

  const videoUrl = String(process.env.VIDEO_URL || '').trim();
  if (!videoUrl) throw new Error('VIDEO_URL is required — pass the reel\'s Blob URL from the dashboard.');

  const run = await loadRecord(runId);
  if (!run.script) throw new Error(`Run ${runId} has no script, so there is no caption to post.`);
  if (!run.media) throw new Error(`Run ${runId} has no media, so there is nothing to post.`);

  await fetchReel(videoUrl, runId);

  const platforms = readPlatforms();
  console.log(
    `  publishing ${runId} to ${platforms ? platforms.join(', ') : 'every enabled platform'}` +
      `${dry ? ' (dry run)' : ''}`
  );

  // A reel fetched into output/ but absent from the record is a false negative in
  // the guard above, so the record is told where the file is.
  run.media = { ...run.media, videoUrl };

  const result = await publishRun({ run, platforms, dry });

  const failed = result.results?.some((r) => r.status === 'failed');
  for (const r of result.results || []) {
    console.log(`  ${r.platform} ${r.status}${r.error ? ` — ${r.error}` : ''}`);
  }

  console.log(`\n+ ${runId} → ${result.status}`);
  if (failed) process.exitCode = 1;
}

// Same guard as scripts/publishDashboard.js, so importing this from a test does
// not start publishing.
const isMain = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

if (isMain) {
  main().catch((err) => {
    console.error(`\nx ${err.message}`);
    process.exit(1);
  });
}
