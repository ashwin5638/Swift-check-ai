/** Status vocabulary. One place decides what a run or a publish result looks
 *  like, so a tag can never appear with two different meanings in two panels.
 *
 *  Every tone is paired with a written label. Colour is never the only carrier
 *  of state. */

const TONES = {
  published: 'ok',
  completed: 'ok',
  ok: 'ok',
  posted: 'ok',
  partial: 'warn',
  'awaiting-approval': 'warn',
  pending: 'warn',
  degraded: 'warn',
  running: 'accent',
  approved: 'accent',
  failed: 'err',
  error: 'err',
  'dry-run': 'idle',
  skipped: 'idle',
  rejected: 'idle',
  unknown: 'idle'
};

const LABELS = {
  'awaiting-approval': 'awaiting approval',
  'dry-run': 'dry run',
  running: 'running'
};

export function tone(status) {
  return TONES[status] || 'idle';
}

export function label(status) {
  if (!status) return 'unknown';
  return LABELS[status] || status;
}

export const PLATFORM_LABEL = { facebook: 'FB', linkedin: 'LI' };

/** The status a run should be *judged* by.
 *
 *  A run's own `status` stops at 'awaiting-approval' and stays there even after a
 *  human approves it. What the operator needs to see is the publish outcome, so
 *  this mirrors the server's runDisplayStatus(): if publishing resolved, that
 *  wins. Without it the header and the run log disagree about the same run. */

export function displayStatus(run) {
  const reached = ['published', 'partial', 'awaiting-approval'];
  if (reached.includes(run?.publish?.status)) return run.publish.status;
  return run?.status ?? 'unknown';
}

/** Derives the headline figures. Returns an em dash rather than a zero when
 *  there is nothing to measure, so an empty console never looks like one
 *  reporting success. */
export function summariseRuns(runs) {
  const total = runs.length;
  if (!total) {
    return { total: 0, passed: null, failed: 0, avgMs: null, calls: null, tokens: null };
  }

  const settled = runs.filter((r) => r.finishedAt);
  const passed = runs.filter((r) => r.status === 'published' || r.status === 'partial').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const timed = settled.map((r) => r.durationMs).filter((n) => Number.isFinite(n));
  const calls = runs.reduce((n, r) => n + (r.llm?.calls || 0), 0);
  const tokens = runs.reduce((n, r) => n + (r.llm?.promptTokens || 0) + (r.llm?.completionTokens || 0), 0);

  return {
    total,
    passed: settled.length ? passed / settled.length : null,
    failed,
    avgMs: timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : null,
    calls,
    tokens
  };
}
