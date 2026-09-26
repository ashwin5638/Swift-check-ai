import { createRequire } from 'node:module';
import express from 'express';

import { summariseRun } from '../server/lib/dashboard.js';
import { captionFor } from '../server/lib/captions.js';
import {
  checkPassphrase,
  clearSessionCookie,
  issueSession,
  isAuthed,
  requireAuth
} from './_lib/auth.js';
import {
  StateError,
  assertSafeId,
  deleteRun,
  getPendingPost,
  getRun,
  listPendingPosts,
  loadCoveredEvents,
  loadRuns,
  resolvePendingPost
} from './_lib/blobState.js';
import { DispatchError, activeRun, dispatchWorkflow, githubConfig } from './_lib/github.js';

/**
 * The Vercel half of the console: an authenticated control plane, nothing more.
 *
 * ## Why this file is not a function
 *
 * The leading underscore keeps Vercel from turning it into one. It is the shared
 * Express app; the ten files beside it are three lines each and exist only to
 * give Vercel a path to route to. See api/health.js for why there are ten of them
 * instead of one catch-all.
 *
 * This deliberately does NOT import server/index.js, even though the route table
 * below is a near-copy of it. Two reasons, both hard:
 *
 *   1. server/config.js mkdirs output/, state/ and logs/ at import time, which
 *      throws EROFS on Vercel's read-only filesystem. It is imported by
 *      orchestrator.js, publisher.js and state.js, so anything that reaches the
 *      pipeline reaches that too.
 *   2. ffmpeg-static and Playwright would follow it into the bundle, and a
 *      function carrying a browser has no way to install that browser's system
 *      libraries anyway.
 *
 * So the routes are written twice, deliberately, and the parts that must not
 * drift — the status derivation, the list shape, the caption text — are imported
 * from server/lib/ as pure functions instead of being reimplemented here. Those
 * two modules have no filesystem or config dependency precisely so this import is
 * legal. If you find yourself adding an fs call to server/lib/dashboard.js,
 * server/lib/captions.js or api/_lib/auth.js, this stops working.
 *
 * Reads are public. Writes require a signed session cookie: see api/_lib/auth.js
 * for why the local API's loopback-and-CORS posture is not enough once every
 * route is a public URL.
 */

const require = createRequire(import.meta.url);
const config = require('../config.json');

// Daily at 06:17 UTC, and already declared workflow_dispatch.
const RUN_WORKFLOW = 'dailyReel.yml';
const PUBLISH_WORKFLOW = 'publishReel.yml';

const app = express();
app.use(express.json());

// Vercel terminates TLS and forwards the request, so this is what the browser
// sent. Only used to decide on the Secure cookie attribute, which would
// otherwise be dropped on a plain-http local preview.
const isSecure = (req) =>
  req.headers['x-forwarded-proto'] === 'https' || Boolean(process.env.VERCEL);

const passphrase = () => process.env.DASHBOARD_PASS || '';
const auth = requireAuth(passphrase(), { secure: true });

// ---- auth -----------------------------------------------------------------
//
// One path with three methods rather than three paths, because every path in
// api/ is a separate Vercel Function and Hobby allows twelve. Login/logout/session
// as distinct files would spend three of the twelve on plumbing.

app.post('/api/auth', (req, res) => {
  const pass = passphrase();
  if (!pass) {
    return res
      .status(503)
      .json({ error: 'DASHBOARD_PASS is not set on this deployment.', code: 'no-passphrase' });
  }
  if (!checkPassphrase(req.body?.pass, pass)) {
    return res.status(401).json({ error: 'That passphrase is not right.', code: 'bad-passphrase' });
  }
  issueSession(res, pass, { secure: isSecure(req) });
  res.json({ ok: true });
});

app.delete('/api/auth', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie({ secure: isSecure(req) }));
  res.json({ ok: true });
});

/** Lets the console show a "Sign in" affordance instead of failing on first click. */
app.get('/api/auth', (req, res) => {
  res.json({
    authenticated: isAuthed(req, passphrase()),
    configured: Boolean(passphrase())
  });
});

// ---- reads (public) --------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  const [running, pending] = await Promise.all([activeRun(), listPendingPosts()]);
  const gh = githubConfig();

  res.json({
    ok: true,
    // Null rather than false when GitHub could not be reached. A "Pipeline:
    // idle" badge that is really "could not check" teaches the operator to
    // ignore the one field meant to stop them double-triggering.
    running: running ? true : false,
    run: running,
    // From config.json, which is a build artefact and therefore readable here.
    config: { brand: config.brand, publish: config.publish, reel: config.reel },
    // The eleven pipeline credentials live in GitHub Actions secrets and are not
    // present in this function, so there is nothing truthful to report. Null
    // tells the panel to say so; a map of eleven `false` would read as "this
    // project is broken", and a map of eleven `true` would tell every anonymous
    // visitor which integrations are wired up.
    credentials: null,
    telegram: null,
    queue: { pending: pending.length },
    github: { configured: Boolean(gh.token && gh.repo), repo: gh.repo || null }
  });
});

app.get('/api/runs', async (_req, res) => {
  res.json({ runs: (await loadRuns()).map(summariseRun) });
});

app.get('/api/runs/:id', async (req, res) => {
  const run = await getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ run });
});

app.get('/api/pending', async (req, res) => {
  res.json({ pending: await listPendingPosts({ includeResolved: req.query.all === '1' }) });
});

app.get('/api/covered', async (_req, res) => {
  res.json({ events: await loadCoveredEvents() });
});

/**
 * Rebuilt from the run record rather than read from output/<id>/<platform>.txt,
 * which is what the local route does and cannot do here. Same bytes: both go
 * through server/lib/captions.js, and test/feedContract.test.js pins the browser
 * copy in client/src/lib/feed.js against it.
 */
app.get('/api/captions/:id/:platform', async (req, res) => {
  const { id, platform } = req.params;
  if (!['facebook', 'linkedin'].includes(platform)) {
    return res.status(400).json({ error: 'Unknown platform' });
  }
  assertSafeId(id);

  const run = await getRun(id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  // A --no-render or --skip-render run has no script, and so no caption file
  // locally either. 404 rather than a blank body, which would paste as "".
  if (!run.script) return res.status(404).json({ error: 'Caption not found' });

  res.type('text/plain').send(captionFor(run.script, run.event, platform));
});

// ---- writes (authenticated) ------------------------------------------------

/** Triggering a run is a request to CI, not to this function. */
app.post('/api/runs', auth, async (req, res) => {
  const dispatched = await dispatchWorkflow(RUN_WORKFLOW, {
    // The workflow's own default is true, so an absent value is safer than an
    // explicit false: it cannot post to two accounts by accident.
    dry_run: req.body?.dry ? 'true' : 'false',
    skip_render: req.body?.skipRender ? 'true' : 'false'
  });
  res.status(202).json({
    accepted: true,
    workflow: dispatched.workflow,
    message: 'Queued in GitHub Actions. The reel appears here when the run finishes.'
  });
});

app.post('/api/runs/:id/publish', auth, async (req, res) => {
  const id = assertSafeId(req.params.id);
  const run = await getRun(id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.media) return res.status(400).json({ error: 'Run has no rendered media' });
  if (!run.media.videoUrl) {
    // The reel has to be somewhere CI can fetch. publishDashboard.js uploads the
    // newest five to Blob; an older one was pruned, so there is no file to post
    // and the workflow would fail on a download instead of here.
    return res.status(409).json({
      error: 'This reel is no longer in the blob store — only the five most recent are kept.'
    });
  }

  const dispatched = await dispatchWorkflow(PUBLISH_WORKFLOW, {
    run_id: id,
    video_url: run.media.videoUrl,
    dry: req.body?.dry ? 'true' : 'false'
  });
  res.status(202).json({ accepted: true, workflow: dispatched.workflow });
});

app.post('/api/pending/:id/approve', auth, async (req, res) => {
  const id = assertSafeId(req.params.id);
  const entry = await getPendingPost(id);
  if (!entry) return res.status(404).json({ error: 'Queue entry not found' });
  if (entry.status !== 'pending') return res.status(409).json({ error: `Already ${entry.status}` });

  const run = await getRun(entry.id);
  if (!run) return res.status(404).json({ error: 'Original run not found' });
  if (!run.media) return res.status(400).json({ error: 'Run has no rendered media' });
  if (!run.media.videoUrl) {
    return res.status(409).json({ error: 'This reel is no longer in the blob store.' });
  }

  const dispatched = await dispatchWorkflow(PUBLISH_WORKFLOW, {
    run_id: id,
    video_url: run.media.videoUrl,
    // The queue records exactly which platforms this reel was gated for, and
    // approving it must not widen that to everything config.json enables.
    platforms: (entry.platforms || []).join(','),
    dry: req.body?.dry ? 'true' : 'false'
  });
  res.status(202).json({ accepted: true, workflow: dispatched.workflow });
});

/**
 * Rejecting and deleting need no CI: neither spends a credential or produces
 * anything, so they are the two writes that can be instant. Both leave a
 * tombstone, because tomorrow's 06:17 run rebuilds state from CI's copy.
 */
app.post('/api/pending/:id/reject', auth, async (req, res) => {
  const id = assertSafeId(req.params.id);
  const entry = await getPendingPost(id);
  if (!entry) return res.status(404).json({ error: 'Queue entry not found' });
  if (entry.status !== 'pending') return res.status(409).json({ error: `Already ${entry.status}` });

  res.json({ ok: true, entry: await resolvePendingPost(id, 'rejected', { note: req.body?.note || null }) });
});

app.delete('/api/runs/:id', auth, async (req, res) => {
  const id = assertSafeId(req.params.id);
  const pending = await listPendingPosts();
  if (pending.some((p) => p.id === id)) {
    return res.status(409).json({ error: 'This reel is awaiting approval — reject it first' });
  }

  await deleteRun(id);
  // There is no output/ directory to clean and no local run record to remove;
  // the blob is pruned by publishDashboard.js, which is the only thing that
  // knows the retention window.
  res.json({ ok: true, removed: 1 });
});

// ---- errors ---------------------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err instanceof StateError || err instanceof DispatchError) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  // Anything reaching here is a bug or an unreachable store. The message is
  // logged by the platform either way, and a leaked stack in a JSON body tells
  // an anonymous caller more about the deployment than it helps.
  console.error('[api] unhandled', err);
  res.status(500).json({ error: 'The control plane hit an unexpected error.' });
});

export { app };
export default app;
