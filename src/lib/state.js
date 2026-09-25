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

// ---- run history (what the dashboard reads) ------------------------------

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

// ---- pending approvals ----------------------------------------------------

export function loadPendingPosts() {
  const data = readJson(config.paths.pendingPosts, { pending: [] });
  return Array.isArray(data.pending) ? data.pending : [];
}

export function savePendingPosts(pending) {
  writeJson(config.paths.pendingPosts, { pending });
}

export function addPendingPost(post) {
  const pending = loadPendingPosts();
  const record = { ...post, createdAt: new Date().toISOString(), status: 'pending' };
  pending.unshift(record);
  savePendingPosts(pending.slice(0, 30));
  return record;
}

export function resolvePendingPost(id, status, detail = {}) {
  const pending = loadPendingPosts();
  const found = pending.find((p) => p.id === id);
  if (!found) return null;
  found.status = status;
  found.resolvedAt = new Date().toISOString();
  Object.assign(found, detail);
  savePendingPosts(pending);
  return found;
}
