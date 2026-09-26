import { app } from './_app.js';

/**
 * Vercel Function: GET, POST and DELETE /api/auth.
 *
 * One path for three operations on purpose — see api/health.js on the twelve
 * Function limit. The client only ever needs one of these at a time, and a
 * login form that posts to /api/auth is no less clear than one that posts to
 * /api/auth/login.
 */
export default app;
