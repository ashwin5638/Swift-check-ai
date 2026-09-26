import { useState } from 'react';
import { IconLock, IconLockOpen } from '@tabler/icons-react';

/**
 * The passphrase gate for the control plane.
 *
 * The read side of the console is public — a run log about public content is
 * worth being able to look at — so this never blocks the page. It appears when
 * someone reaches for a control they are not signed in for, which means the
 * first thing an anonymous visitor can do is look and the first thing they
 * cannot do is spend a Facebook token.
 *
 * The passphrase goes to the server and is never held in state beyond this form:
 * the API answers with an httpOnly cookie, so there is nothing in the bundle, in
 * localStorage, or in a React devtools inspector to steal. That is the whole
 * reason it is a passphrase and not a token in the client.
 */
export default function Login({ open, configured, onSubmit, onClose, error }) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    const ok = await onSubmit(pass);
    // Only clear on success. Wiping the field on a wrong passphrase makes the
    // second and third attempts slower than the first, which is the wrong thing
    // to do to someone who is probably just typing.
    if (ok) setPass('');
    setBusy(false);
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Sign in">
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <IconLock size={15} stroke={1.5} aria-hidden="true" />
          <h2>Sign in to control the pipeline</h2>
        </div>

        {configured === false ? (
          <p className="note">
            This deployment has no <code>DASHBOARD_PASS</code> set, so the trigger, approve and
            delete controls are disabled. Add it in the Vercel project settings and redeploy.
          </p>
        ) : (
          <>
            <p className="note">
              Reading the run log is open to anyone with the link. Triggering a run, approving a
              reel or posting to Facebook and LinkedIn needs the passphrase.
            </p>

            <label className="field">
              <span className="label">Passphrase</span>
              <input
                type="password"
                className="input"
                value={pass}
                autoFocus
                autoComplete="current-password"
                onChange={(e) => setPass(e.target.value)}
                placeholder="DASHBOARD_PASS"
              />
            </label>

            {error ? (
              <p className="note" role="alert" style={{ color: 'var(--err)' }}>
                {error}
              </p>
            ) : null}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {configured === false ? null : (
            <button type="submit" className="btn btn-primary" disabled={busy || !pass}>
              <IconLockOpen size={13} stroke={1.5} aria-hidden="true" />
              {busy ? 'Checking…' : 'Sign in'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** The affordance in the top rail. Hidden once signed in, and while the local
 *  API is in use — that one has no sessions and would reject the cookie. */
export function SignInButton({ onClick }) {
  return (
    <button type="button" className="btn btn-sm btn-ghost" onClick={onClick}>
      <IconLock size={12} stroke={1.5} aria-hidden="true" />
      Sign in
    </button>
  );
}
