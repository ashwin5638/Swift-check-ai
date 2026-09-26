import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Flatten to comparable word tokens, dropping stopwords, for cheap fuzzy title matching. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this', 'will',
  'new', 'says', 'say', 'said', 'after', 'over', 'into', 'amid', 'more', 'than', 'has', 'have'
]);

export function normalizeTitle(title = '') {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

export function titleSimilarity(a, b) {
  const setA = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  return shared / Math.min(setA.size, setB.size);
}

// ---- covered events (dedupe log) ----------------------------------------

export function loadCoveredEvents() {
  const data = readJson(config.paths.coveredEvents, { events: [] });
  return Array.isArray(data.events) ? data.events : [];
}

export function saveCoveredEvents(events) {
  writeJson(config.paths.coveredEvents, { events });
}

/** True if this story is a near-duplicate of something already covered. */
export function isAlreadyCovered(title, threshold = 0.6) {
  return loadCoveredEvents().some((e) => titleSimilarity(e.title, title) >= threshold);
}

export function recordCoveredEvent(entry) {
  const events = loadCoveredEvents();
  events.unshift({
    id: entry.id,
    title: entry.title,
    source: entry.source,
    url: entry.url || null,
    coveredAt: new Date().toISOString(),
    reason: entry.reason || null
  });
  // Keep the file small — this is a dedupe log, not an analytics DB.
  saveCoveredEvents(events.slice(0, 200));
  return events[0];
}



export function loadRuns() {
  const data = readJson(config.paths.runs, { runs: [] });
  return Array.isArray(data.runs) ? data.runs : [];
}

export function saveRunRecord(run) {
  const runs = loadRuns();
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) runs[idx] = { ...runs[idx], ...run };
  else runs.unshift(run);
  writeJson(config.paths.runs, { runs: runs.slice(0, 60) });
  return run;
}

export function getRun(id) {
  return loadRuns().find((r) => r.id === id) || null;
}

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

/** Drops a run from the history log. Returns false if the id was not there. */
export function deleteRun(id) {
  const runs = loadRuns();
  const next = runs.filter((r) => r.id !== id);
  if (next.length === runs.length) return false;
  writeJson(config.paths.runs, { runs: next });
  return true;
}

// ---- pending approvals ----------------------------------------------------

export function loadPendingPosts() {
  const data = readJson(config.paths.pendingPosts, { pending: [] });
  return Array.isArray(data.pending) ? data.pending : [];
}

export function savePendingPosts(pending) {
  writeJson(config.paths.pendingPosts, { pending });
}

/**
 * Queues a reel for approval. One entry per run: re-running the same run id
 * replaces the existing entry instead of stacking duplicates, which would
 * otherwise show the same reel in the dashboard three times.
 */
export function addPendingPost(post) {
  const pending = loadPendingPosts();
  const id = post.id || post.runId;
  if (!id) throw new Error('addPendingPost needs an id or runId');

  const record = { ...post, id, createdAt: new Date().toISOString(), status: 'pending' };
  const existing = pending.findIndex((p) => p.id === id);
  if (existing >= 0) pending[existing] = { ...pending[existing], ...record };
  else pending.unshift(record);

  savePendingPosts(pending.slice(0, 30));
  return record;
}

export function getPendingPost(id) {
  return loadPendingPosts().find((p) => p.id === id) || null;
}

export function listPendingPosts({ includeResolved = false } = {}) {
  const all = loadPendingPosts();
  return includeResolved ? all : all.filter((p) => p.status === 'pending');
}

/**
 * Closes out a queued reel. Throws for a missing or already-resolved entry so a
 * double-click (or two racing requests) cannot silently overwrite an outcome
 * that has already been reported to the user.
 */
export function resolvePendingPost(id, status, detail = {}) {
  const pending = loadPendingPosts();
  const found = pending.find((p) => p.id === id);
  if (!found) throw new Error(`Queue entry not found: ${id}`);
  if (found.status !== 'pending') throw new Error(`Queue entry ${id} is already ${found.status}`);

  found.status = status;
  found.resolvedAt = new Date().toISOString();
  Object.assign(found, detail);
  savePendingPosts(pending);
  return found;
}
