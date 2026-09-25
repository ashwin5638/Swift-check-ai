import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, credentialStatus } from './config.js';
import { createLogger } from './lib/logger.js';
import { callLog } from './lib/llm.js';
import { saveRunRecord, recordCoveredEvent } from './lib/state.js';
import { newsScout } from './agents/newsScout.js';
import { eventRanker } from './agents/eventRanker.js';
import { scriptWriter } from './agents/scriptWriter.js';
import { visualBuilder } from './agents/visualBuilder.js';
import { publisher } from './agents/publisher.js';

const log = createLogger('orchestrator');

/**
 * AGENT 0 — Orchestrator. Chains 1→5 exactly once.
 *
 * Deliberately a plain async function, not an agent framework: CrewAI/AutoGen
 * add inter-agent message passing that costs tokens without changing the
 * output. This chain makes the LLM boundary visible — exactly two calls.
 */
export async function runPipeline({ dry = false, forcePublish = false, skipRender = false } = {}) {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const steps = [];

  log.step(`Run ${runId} starting${dry ? ' (DRY RUN)' : ''}`);
  reportCredentials();

  const record = {
    id: runId,
    startedAt: startedAt.toISOString(),
    status: 'running',
    dry,
    steps,
    llm: { calls: 0, promptTokens: 0, completionTokens: 0 }
  };
  saveRunRecord(record);

  try {
    // ---- 1. News Scout (0 LLM calls) -----------------------------------
    let t = Date.now();
    const candidates = await newsScout();
    steps.push({ agent: 'newsScout', llmCalls: 0, ms: Date.now() - t, detail: `${candidates.length} candidates` });
    log.info(`Candidate pool: ${candidates.length} stories`);

    // ---- 2. Event Ranker (1 LLM call) ----------------------------------
    t = Date.now();
    const event = await eventRanker(candidates);
    steps.push({ agent: 'eventRanker', llmCalls: 1, ms: Date.now() - t, detail: event.title });

    // ---- 3. Script Writer (1 LLM call) ---------------------------------
    t = Date.now();
    const script = await scriptWriter(event);
    steps.push({ agent: 'scriptWriter', llmCalls: 1, ms: Date.now() - t, detail: `${script.beats.length} beats` });

    // ---- 4. Visual Builder (0 LLM calls) -------------------------------
    t = Date.now();
    const media = skipRender
      ? { skipped: true }
      : await visualBuilder({ script, event, runId });
    if (!skipRender) steps.push({ agent: 'visualBuilder', llmCalls: 0, ms: Date.now() - t, detail: `${media.durationSeconds}s` });

    // ---- 5. Publisher (0 LLM calls) ------------------------------------
    t = Date.now();
    const publishResult = skipRender
      ? { status: 'skipped', reason: 'render-skipped', results: [] }
      : await publisher({ runId, script, media, event, force: forcePublish, dry });
    steps.push({ agent: 'publisher', llmCalls: 0, ms: Date.now() - t, detail: publishResult.status });

    // ---- bookkeeping ----------------------------------------------------
    recordCoveredEvent({ id: runId, title: event.title, source: event.source, url: event.url, reason: event.reason });

    const finalRecord = {
      ...record,
      status: publishResult.status,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      event: { title: event.title, source: event.source, url: event.url, reason: event.reason },
      script,
      media: media.skipped ? null : { videoUrl: media.videoUrl, durationSeconds: media.durationSeconds, sizeBytes: media.sizeBytes, hasVoiceover: media.hasVoiceover, image: media.image },
      beats: media.skipped ? script.beats : media.beatFrames,
      publish: publishResult,
      llm: {
        calls: callLog.totalCalls,
        promptTokens: callLog.totalPromptTokens,
        completionTokens: callLog.totalCompletionTokens
      }
    };
    saveRunRecord(finalRecord);

    await writeArtifacts(runId, finalRecord);
    printSummary(finalRecord);
    return finalRecord;
  } catch (err) {
    log.error('Pipeline failed', { reason: err.message, runId });
    saveRunRecord({ ...record, status: 'failed', error: err.message, finishedAt: new Date().toISOString() });
    throw err;
  }
}

function reportCredentials() {
  const status = credentialStatus();
  const missing = Object.entries(status).filter(([, present]) => !present).map(([k]) => k);
  if (missing.length) log.warn(`Not configured (non-fatal for a dry run): ${missing.join(', ')}`);
}

/** Plain files next to the mp4 — the platform APIs and humans both want these. */
async function writeArtifacts(runId, record) {
  const dir = path.join(config.paths.output, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify(record, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'facebook.txt'), captionFile(record.script.facebookCaption, record.script.hashtags, record.event.url), 'utf8');
  await fs.writeFile(path.join(dir, 'linkedin.txt'), captionFile(record.script.linkedinCaption, record.script.hashtags, record.event.url), 'utf8');
}

function captionFile(caption, hashtags, url) {
  return [caption, hashtags?.join(' '), url].filter(Boolean).join('\n\n') + '\n';
}

function printSummary(record) {
  log.ok(`Run ${record.id} → ${record.status} in ${(record.durationMs / 1000).toFixed(1)}s`);
  log.info(`Story: ${record.event.title}`);
  log.info(`LLM: ${record.llm.calls} calls, ${record.llm.promptTokens} in / ${record.llm.completionTokens} out tokens`);
  if (record.media) log.info(`Reel: output/${record.id}.mp4 (${record.media.durationSeconds}s)`);
}

// ---- CLI entry point -------------------------------------------------------
// pathToFileURL, not string concatenation: on Windows `file://` + `D:\...`
// yields two slashes while import.meta.url has three, so a hand-rolled check
// silently never matches and the command exits 0 having done nothing.
const isMain = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

if (isMain) {
  const dry = process.argv.includes('--dry');
  const forcePublish = process.argv.includes('--force-publish');
  const skipRender = process.argv.includes('--no-render');

  runPipeline({ dry, forcePublish, skipRender })
    .then((r) => process.exit(r.status === 'failed' ? 1 : 0))
    .catch(() => process.exit(1));
}
