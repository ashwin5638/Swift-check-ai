/**
 * The caption text, in one place.
 *
 * Three callers need these exact bytes and none of them can import each other:
 * orchestrator.js writes them to output/<id>/<platform>.txt, Express serves them
 * from that path, and the Vercel function has no filesystem to read them from and
 * rebuilds them from the run record instead. The browser has a fourth copy in
 * client/src/lib/feed.js, a copy of this for the static read-only build.
 *
 * This is the *approval* caption — what the operator reviewed and what the .txt
 * file holds. It is deliberately not what publisher.js posts: that strips angle
 * brackets for Facebook and prefixes the source URL for LinkedIn, because the
 * platform APIs want a different string than a human signs off on.
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
