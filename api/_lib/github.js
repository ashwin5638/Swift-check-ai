/**
 * The GitHub Actions half of the control plane.
 *
 * Nothing renders on Vercel. A Vercel function has a read-only filesystem, a
 * 300s ceiling on Hobby, and no way to install Playwright's system libraries, so
 * ffmpeg and the browser upload simply cannot run there. What Vercel *can* do is
 * ask CI to run them, and CI already does: dailyReel.yml has fired on a schedule
 * every morning and has declared workflow_dispatch all along. This module is the
 * button wired to that.
 *
 * The consequence is that these calls return 204 immediately and the reel appears
 * minutes later, when CI has committed the new state. The dashboard shows the live
 * Actions run in the meantime, so it never looks like a dropped click.
 */

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

// Workflow ids become a path segment, so they are restricted to the characters a
// real workflow filename uses. Not a defence against a determined caller — they
// need a valid token either way — but it keeps a bad config from building a
// surprising URL.
const SAFE_WORKFLOW = /^[\w.-]{1,100}\.ya?ml$/;

const SAFE_REF = /^[A-Za-z0-9._/-]{1,255}$/;

export class DispatchError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DispatchError';
    this.status = status;
  }
}

export function githubConfig(env = process.env) {
  return {
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPO,
    ref: env.GITHUB_REF || 'main'
  };
}

/**
 * Why each one is checked the way it is, because the failures are otherwise
 * indistinguishable from each other: a dispatch against a token without Actions
 * write returns 403, and one against a workflow file that is not on the target
 * ref returns 422. Both read as "GitHub said no" from the browser.
 */
function requireConfig(cfg, workflow) {
  if (!cfg.token) throw new DispatchError('GITHUB_TOKEN is not set on this deployment.', 503);
  if (!cfg.repo) throw new DispatchError('GITHUB_REPO is not set on this deployment.', 503);
  if (!SAFE_WORKFLOW.test(workflow)) throw new DispatchError(`Malformed workflow id: ${workflow}`, 400);
  if (!SAFE_REF.test(cfg.ref)) throw new DispatchError(`GITHUB_REF is malformed: ${cfg.ref}`, 500);
}

async function githubFetch(cfg, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...(init.headers || {})
    }
  });
  return res;
}

/**
 * Asks CI to run a workflow. 204 is success and carries no body, so there is
 * nothing to return — the caller answers 202 and the dashboard polls.
 *
 * A double-click is not specially handled here. dailyReel.yml declares
 * `concurrency: { group: daily-reel, cancel-in-progress: false }`, so a second
 * dispatch queues behind the first instead of running two pipelines at once, and
 * a lock on Vercel would be redundant as well as useless (module scope is
 * per-instance).
 */
export async function dispatchWorkflow(workflow, inputs = {}, env = process.env) {
  const cfg = githubConfig(env);
  requireConfig(cfg, workflow);

  const res = await githubFetch(
    cfg,
    `/repos/${cfg.repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: cfg.ref, inputs: mapInputs(inputs) })
    }
  );

  // 204 per the docs; 200 appears on some API versions for an accepted dispatch.
  if (res.status === 204 || res.status === 200) return { workflow, ref: cfg.ref };

  const detail = await res.json().catch(() => ({}));
  if (res.status === 403) {
    throw new DispatchError(
      'GitHub refused the dispatch. The token needs Actions: read and write on this repository.',
      403
    );
  }
  if (res.status === 422) {
    throw new DispatchError(
      `GitHub rejected the dispatch — check that ${workflow} exists on ${cfg.ref}.`,
      422
    );
  }
  throw new DispatchError(detail.message || `GitHub returned ${res.status}.`, res.status);
}

/**
 * workflow_dispatch inputs are always strings, and a boolean input is declared
 * with a default. Coercing here means callers can pass real booleans without
 * every call site remembering, and an omitted value is left out entirely so the
 * workflow's own default applies.
 */
function mapInputs(inputs) {
  const out = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * The in-progress run, for the dashboard's busy indicator.
 *
 * This replaces the `running` boolean the local API keeps in module scope, which
 * is meaningless here: a serverless instance is recycled between requests, so it
 * would report "idle" to everyone except the one caller lucky enough to land on
 * the instance that just handled a dispatch. The real question — is CI busy right
 * now — has an actual answer, and it is this endpoint.
 *
 * A failure is not an error. An expired token or a GitHub outage should cost the
 * busy indicator, not the run log, so this resolves to null and the console
 * renders the control as available.
 */
export async function activeRun(env = process.env) {
  const cfg = githubConfig(env);
  if (!cfg.token || !cfg.repo) return null;

  try {
    const res = await githubFetch(
      cfg,
      `/repos/${cfg.repo}/actions/runs?status=in_progress&per_page=1`
    );
    if (!res.ok) return null;

    const data = await res.json();
    const run = data.workflow_runs?.[0];
    if (!run) return null;

    return {
      id: run.id,
      name: run.name,
      status: run.status,
      // null while queued, which is the case the dashboard most needs to
      // distinguish from "actually rendering".
      startedAt: run.run_started_at ?? run.created_at ?? null,
      url: run.html_url
    };
  } catch {
    return null;
  }
}
