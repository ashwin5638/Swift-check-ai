/**
 * The caption text, in one place.
 *
 * Three callers need these exact bytes and cannot import each other: orchestrator
 * writes them to output/<id>/<platform>.txt, Express serves them from there, and
 * the Vercel function has no filesystem so it rebuilds them from the run record.
 * A fourth copy lives in client/src/lib/feed.js for the static read-only build.
 *
 * This is the *approval* caption — what the operator reviewed. It is deliberately
 * not what publisher.js posts: that strips angle brackets for Facebook and
 * prefixes the source URL for LinkedIn, because the platform APIs want a
 * different string than a human signs off on.
 */

/**
 * @param platform 'facebook' | 'linkedin' — anything else falls back to facebook
 *   rather than throwing, so a record with a missing field reads as empty instead
 *   of breaking the copy button.
 */
export function captionFor(script = {}, event = {}, platform = 'facebook') {
  const body = platform === 'linkedin' ? script.linkedinCaption : script.facebookCaption;
  // hashtags is stored as an array, and letting it stringify would hand the
  // operator comma-separated tags. The trailing newline is the file's own.
  return [body, script.hashtags?.join(' '), event?.url].filter(Boolean).join('\n\n') + '\n';
}
