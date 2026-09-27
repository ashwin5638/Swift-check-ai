/**
 * The read-model the console renders.
 *
 * Pure, and deliberately free of `config` and `node:fs` imports. The Vercel
 * function serves the same shapes as the local Express API but runs on a
 * read-only filesystem where importing config.js fails at module load (it
 * mkdirs). Sharing these derivations stops the two deployments from disagreeing
 * about what a run's status is.
 */

/**
 * The status the dashboard shows for a run.
 *
 * The pipeline writes run.status once, but publishing happens later and from a
 * different place (the queue's approve button, or a retry), so the top-level
 * status goes stale — a run that posted to both platforms still reads "skipped".
 * publish.status is the newer answer whenever it means something, and only
 * overrides on a positive outcome so a genuine failure is never masked.
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
