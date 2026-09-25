import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config, env, credentialStatus } from './config.js';
import { createLogger } from './lib/logger.js';
import { loadRuns, getRun, loadCoveredEvents } from './lib/state.js';
import { runPipeline } from './orchestrator.js';
import { publisher } from './agents/publisher.js';

const log = createLogger('server');
const app = express();

app.use(cors());
app.use(express.json());

// Generated reels. Streamed with range support so the dashboard <video> can seek.
app.use('/media', express.static(config.paths.output, { acceptRanges: true, maxAge: '1h' }));

let running = false;

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    running,
    config: { brand: config.brand.name, publish: config.publish, reel: config.reel },
    credentials: credentialStatus()
  });
});

app.get('/api/runs', (_req, res) => {
  const runs = loadRuns().map(summarise);
  res.json({ runs });
});

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ run });
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

/** Approve-and-post a reel that was gated by requireApproval. */
app.post('/api/runs/:id/publish', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.media) return res.status(400).json({ error: 'Run has no rendered media' });
  if (running) return res.status(409).json({ error: 'A run is already in progress' });

  running = true;
  try {
    const result = await publisher({
      runId: run.id,
      script: run.script,
      media: { videoPath: path.join(config.paths.output, `${run.id}.mp4`) },
      event: run.event,
      force: true,
      dry: Boolean(req.body?.dry)
    });
    run.publish = result;
    res.json({ ok: true, publish: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    running = false;
  }
});

app.get('/api/covered', (_req, res) => {
  res.json({ events: loadCoveredEvents() });
});

app.get('/api/captions/:id/:platform', (req, res) => {
  const { id, platform } = req.params;
  if (!['facebook', 'linkedin'].includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
  const file = path.join(config.paths.output, id, `${platform}.txt`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Caption not found' });
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

function summarise(run) {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    status: run.status,
    error: run.error || null,
    title: run.event?.title || null,
    source: run.event?.source || null,
    videoUrl: run.media?.videoUrl || null,
    reelDuration: run.media?.durationSeconds || null,
    publishStatus: run.publish?.status || null,
    llm: run.llm || null
  };
}

app.listen(env.port, () => {
  log.ok(`API listening on http://localhost:${env.port}`);
});
