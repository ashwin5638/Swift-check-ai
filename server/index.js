import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config, env, credentialStatus } from './config.js';
import { createLogger } from './lib/logger.js';
import { loadRuns, getRun, deleteRun, loadCoveredEvents, listPendingPosts, getPendingPost, resolvePendingPost } from './lib/state.js';
import { publishRun } from './lib/publishRun.js';
import { summariseRun } from './lib/dashboard.js';
import { runPipeline } from './orchestrator.js';

const log = createLogger('server');
const app = express();

// Only local origins. A page served from anywhere else on the internet has a
// different Origin, so this blocks drive-by requests to 127.0.0.1:4000 from
// sites you happen to be visiting while the dashboard is up. Requests with no
// Origin header (curl, same-origin navigations) still pass.
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(cors({
  origin(origin, cb) {
    cb(null, !origin || LOCAL_ORIGIN.test(origin));
  }
}));
app.use(express.json());

/**
 * Resolves a path under output/ and refuses anything that escapes it.
 * Guards `/api/captions/:id` where `id` is caller-controlled: Express decodes
 * %2F, so `..%2f..` would otherwise traverse out of the directory.
 */
function safeOutputPath(...segments) {
  const root = path.resolve(config.paths.output);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

// Run ids are generated as ISO timestamps, so this is a strict allowlist that
// also rejects anything starting with a dot.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Generated reels. Streamed with range support so the dashboard <video> can seek.
app.use('/media', express.static(config.paths.output, { acceptRanges: true, maxAge: '1h' }));

let running = false;

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    running,
    config: { brand: config.brand.name, publish: config.publish, reel: config.reel },
    credentials: credentialStatus(),
    telegram: {
      enabled: Boolean(config.publish.notifyTelegram && env.telegram.botToken && env.telegram.chatId),
      configured: Boolean(env.telegram.botToken && env.telegram.chatId)
    },
    queue: { pending: listPendingPosts().length }
  });
});

app.get('/api/runs', (_req, res) => {
  const runs = loadRuns().map(summariseRun);
  res.json({ runs });
});

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ run });
});

/**
 * Removes a run from the history and its reel from disk. The queue is checked
 * first: a reel awaiting approval is still a live candidate, so deleting it
 * would silently drop something a human has not decided on yet.
 */
app.delete('/api/runs/:id', (req, res) => {
  const { id } = req.params;
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Malformed run id' });
  if (running) return res.status(409).json({ error: 'A run is already in progress' });
  if (!getRun(id)) return res.status(404).json({ error: 'Run not found' });
  if (listPendingPosts().some((p) => p.id === id)) {
    return res.status(409).json({ error: 'This reel is awaiting approval — reject it first' });
  }

  // The work folder, the rendered reel and the thumbnail, if each was produced.
  const targets = [safeOutputPath(id), safeOutputPath(`${id}.mp4`), safeOutputPath(`${id}.jpg`)]
    .filter(Boolean);
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true });

  deleteRun(id);
  log.info('Run deleted', { runId: id, files: targets.length });
  res.json({ ok: true, removed: targets.length });
});

/** Triggers the full chain. Guarded so a double-click can't start two runs. */
app.post('/api/runs', async (req, res) => {
  if (running) return res.status(409).json({ error: 'A run is already in progress' });

  running = true;
  res.status(202).json({ accepted: true });

  try {
    await runPipeline({
      dry: Boolean(req.body?.dry),
      forcePublish: Boolean(req.body?.forcePublish),
      skipRender: Boolean(req.body?.skipRender)
    });
  } catch (err) {
    log.error('Dashboard-triggered run failed', { reason: err.message });
  } finally {
    running = false;
  }
});

/**
 * Shared publish path. Both the run-level button and the queue's approve button
 * land in server/lib/publishRun.js so they cannot drift apart — and so CI, which
 * is what actually publishes for the Vercel deployment, runs the same code.
 */

/** Approve-and-post a reel that was gated by requireApproval. */
app.post('/api/runs/:id/publish', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.media) return res.status(400).json({ error: 'Run has no rendered media' });
  if (running) return res.status(409).json({ error: 'A run is already in progress' });

  running = true;
  try {
    const result = await publishRun({ run, dry: req.body?.dry });
    res.json({ ok: true, publish: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    running = false;
  }
});

// ---- approval queue ------------------------------------------------------

app.get('/api/pending', (req, res) => {
  const includeResolved = req.query.all === '1';
  res.json({ pending: listPendingPosts({ includeResolved }) });
});

/** Approve a queued reel: posts to exactly the platforms it was queued for. */
app.post('/api/pending/:id/approve', async (req, res) => {
  const entry = getPendingPost(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Queue entry not found' });
  if (entry.status !== 'pending') return res.status(409).json({ error: `Already ${entry.status}` });
  if (running) return res.status(409).json({ error: 'A run is already in progress' });

  const run = getRun(entry.id);
  if (!run) return res.status(404).json({ error: 'Original run not found' });
  if (!run.media) return res.status(400).json({ error: 'Run has no rendered media' });

  running = true;
  try {
    const result = await publishRun({ run, platforms: entry.platforms, dry: req.body?.dry });
    res.json({ ok: true, publish: result });
  } catch (err) {
    resolvePendingPost(entry.id, 'failed', { error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    running = false;
  }
});

/** Decline a queued reel. Nothing is published and the reel is kept on disk. */
app.post('/api/pending/:id/reject', (req, res) => {
  const entry = getPendingPost(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Queue entry not found' });
  if (entry.status !== 'pending') return res.status(409).json({ error: `Already ${entry.status}` });

  const updated = resolvePendingPost(entry.id, 'rejected', { note: req.body?.note || null });
  log.info('Reel rejected', { runId: entry.id });
  res.json({ ok: true, entry: updated });
});

app.get('/api/covered', (_req, res) => {
  res.json({ events: loadCoveredEvents() });
});

app.get('/api/captions/:id/:platform', (req, res) => {
  const { id, platform } = req.params;
  if (!['facebook', 'linkedin'].includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
  if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Malformed run id' });

  const file = safeOutputPath(id, `${platform}.txt`);
  if (!file) return res.status(400).json({ error: 'Malformed run id' });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Caption not found' });
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

const server = app.listen(env.port, env.host, () => {
  // Report what was actually bound, not what was requested.
  const addr = server.address();
  const shown = typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`;
  log.ok(`API listening on http://${shown}`);
  if (addr.address === '0.0.0.0' || addr.address === '::') {
    log.warn('Bound to every interface — the publish endpoint is reachable from your network.');
    log.warn('Set HOST=127.0.0.1 in .env to keep it on this machine.');
  }
});
