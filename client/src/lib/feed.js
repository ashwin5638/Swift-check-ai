/**
 * Data source for the read-only dashboard.
 *
 * The Vercel deployment is a static site, so there is no API to ask. Instead CI
 * commits the run history to client/public/data/runs.json after each run and
 * Vercel serves it as a plain asset — one request replaces the ten the live
 * dashboard makes, and reels point at Vercel Blob rather than /media.
 *
 * Full run records ship, not the reduced shape the Express API returns, so the
 * detail view, the beat timings and both captions are all available offline.
 * Captions in particular live in the record itself, which is what lets the copy
 * button work without an endpoint.
 *
 * Local `npm run dev` keeps talking to the API on :4000, so the two modes never
 * both try to own the same view. VITE_READ_ONLY=1 selects the static feed; it is
 * set on the Vercel project.
 */

// Optional access: Vite replaces import.meta.env at build time, but this module
// is also imported by the Node test suite, where the object does not exist.
// Vite always defines it, so a real build is unaffected.
export const READ_ONLY = import.meta.env?.VITE_READ_ONLY === '1';

const FEED_URL = '/data/runs.json';

/** One reel is 8.34 MB, so a daily view is a real transfer — poll lazily. */
export const POLL_MS = READ_ONLY ? 60_000 : 5_000;

/**
 * Reads the published run history.
 *
 * A 404 is the normal state of a project that has not run its first reel yet, so
 * it resolves to an empty history rather than an error — otherwise the console
 * opens on "link lost", which reads as a broken deployment instead of an empty
 * one. Anything else is a real failure and throws.
 */
export async function loadFeed() {
  const res = await fetch(FEED_URL, { cache: 'no-cache' });
  if (res.status === 404) return { runs: [], generatedAt: null };

  if (!res.ok) {
    throw new Error(`Could not read ${FEED_URL}: HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    runs: Array.isArray(data.runs) ? data.runs : [],
    generatedAt: data.generatedAt ?? null
  };
}

/**
 * Reassembles the caption exactly as orchestrator.js writes it to
 * output/<id>/<platform>.txt, so the copy button pastes the same bytes the
 * publisher would have posted rather than a reconstruction of them.
 */
export function captionFor(run, platform) {
  const script = run?.script ?? {};
  const body = platform === 'linkedin' ? script.linkedinCaption : script.facebookCaption;
  const hashtags = script.hashtags?.join(' ');
  return [body, hashtags, run?.event?.url].filter(Boolean).join('\n\n') + '\n';
}
