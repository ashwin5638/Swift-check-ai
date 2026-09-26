import path from 'node:path';

import { config, env } from '../config.js';
import { publisher } from '../agents/publisher.js';
import { resolvePendingPost, saveRunRecord } from './state.js';
import { notifyPublished } from './telegram.js';

/**
 * The one path to a published reel.
 *
 * The run-level button and the queue's approve button both land here so they
 * cannot drift apart — the difference between them is only which platforms are
 * allowed, and a second copy of this function is how "approved for Facebook,
 * posted to both" happens.
 *
 * Extracted so CI can publish a reel it did not render. A dashboard-triggered
 * approve on Vercel cannot post anything itself, so it dispatches a workflow,
 * and that workflow needs the same bookkeeping this does: update the record,
 * close the queue entry, and tell Telegram.
 */
export async function publishRun({ run, platforms, dry }) {
  const result = await publisher({
    runId: run.id,
    script: run.script,
    media: { videoPath: path.join(config.paths.output, `${run.id}.mp4`) },
    event: run.event,
    force: true,
    dry: Boolean(dry),
    platforms
  });

  // Keep the run record in step with whatever we just did.
  run.publish = result;
  saveRunRecord(run);

  const failed = result.results?.some((r) => r.status === 'failed');
  if (platforms) {
    // Bookkeeping only. The reel has already been posted at this point, so a
    // failure here must not surface as an error the client would retry.
    try {
      resolvePendingPost(run.id, failed ? 'failed' : 'approved', {
        resolvedPublish: result,
        error: result.results?.find((r) => r.status === 'failed')?.error || null
      });
    } catch (err) {
      console.warn(`  ! could not close out queue entry: ${err.message}`);
    }
  }

  if (!dry && !failed) {
    // Same resolution as orchestrator.js, so a dashboard-triggered publish and a
    // scheduled one put the same link in the Telegram message.
    void notifyPublished({
      headline: run.script?.headline,
      results: result.results,
      dashboardUrl: process.env.DASHBOARD_URL || `http://localhost:${env.port}`
    }).catch(() => {});
  }

  return result;
}
