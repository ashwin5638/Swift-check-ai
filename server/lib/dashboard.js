/**
 * The read-model the console renders.
 *
 * Pure, and deliberately free of `config` and `node:fs` imports. That constraint
 * is the whole point: the Vercel function serves the same shapes as the local
 * Express API, and it runs on a read-only filesystem where importing config.js
 * fails at module load because config.js mkdirs output/, state/ and logs/. Sharing
 * these derivations means the two deployments cannot drift into disagreeing about
 * what a run's status is, which would show a published reel as skipped on one and
 * published on the other.
 */

/**
 * The status the dashboard should show for a run.
 *
 * The pipeline writes run.status once, when it finishes, but publishing happens
 * later and from a different place (the queue's approve button, or a retry). The
 * top-level status is therefore stale by the time a reel reaches a platform, and
 * a run that posted to both Facebook and LinkedIn still reads "skipped".
 *
 * publish.status is the newer, more accurate answer whenever it got far enough
 * to mean something. It only overrides on a positive outcome, so a pipeline that
 * genuinely failed is never masked by a later partial publish.
 */
export function runDisplayStatus(run) {
  const reached = ['published', 'partial', 'awaiting-approval'];
  if (reached.includes(run?.publish?.status)) return run.publish.status;
  return run?.status ?? 'unknown';
}

/**
 * Flattens a full run record into the per-run shape the run log and KPI strip
 * read. The detail pane takes the unflattened record from /api/runs/:id, so this
 * is only the list view.
 */
export function summariseRun(run) {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    status: runDisplayStatus(run),
    error: run.error || null,
    title: run.event?.title || null,
    source: run.event?.source || null,
    videoUrl: run.media?.videoUrl || null,
    reelDuration: run.media?.durationSeconds || null,
    publishStatus: run.publish?.status || null,
    // Lets the dashboard flag a reel that rendered without narration.
    hasVoiceover: run.media?.hasVoiceover ?? null,
    llm: run.llm || null
  };
}
