import { app } from './_app.js';

/**
 * Vercel Function: GET /api/health
 *
 * One of nine three-line entry files, and that is deliberate. Vercel turns every
 * file under api/ into its own Function and does not route catch-all segments
 * outside Next.js, so the alternatives are a catch-all that silently 404s on
 * two-segment paths, or a vercel.json rewrite whose effect on req.url you cannot
 * check without a deployment. Nine real paths cost nine cold starts and nothing
 * else — and nine is under Hobby's limit of twelve.
 */
export default app;
