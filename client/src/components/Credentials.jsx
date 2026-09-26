import { Tag } from './ui.jsx';

/** Which secrets the process actually resolved at boot. A missing key is a
 *  failed run waiting to happen, so it is listed before anything else. */
export default function Credentials({ health }) {
  if (!health) {
    return (
      <p className="note" style={{ marginTop: 0 }}>
        Not connected. The credential report appears once the API answers.
      </p>
    );
  }

  // The Vercel control plane answers null: the eleven keys live in GitHub Actions
  // secrets and are not present in the function, so there is nothing true to
  // report. Listing them as "missing" would send someone off to debug a
  // deployment that is working exactly as intended.
  if (health.credentials === null) {
    return (
      <p className="note" style={{ marginTop: 0 }}>
        The eleven pipeline keys are set as GitHub Actions secrets. The control plane never holds
        them, so it cannot report on them — <code>npm run check:keys</code> in CI is the place
        that does.
      </p>
    );
  }

  const creds = Object.entries(health.credentials ?? {});
  const missing = creds.filter(([, ok]) => !ok).length;
  const telegram = health.telegram ?? {};

  return (
    <div>
      <div className="creds">
        {creds.map(([key, ok]) => (
          <div className="cred" key={key}>
            <span className="name" title={key}>
              {key}
            </span>
            <Tag tone={ok ? 'ok' : 'err'}>{ok ? 'set' : 'missing'}</Tag>
          </div>
        ))}

        <div className="cred">
          <span className="name">telegramAlerts</span>
          <Tag tone={telegram.enabled ? 'ok' : 'idle'}>
            {telegram.enabled ? 'on' : 'off'}
          </Tag>
        </div>
      </div>

      {telegram.configured && !telegram.enabled ? (
        <p className="note">
          The bot token and chat id are set, but <code>notifyTelegram</code> is false in
          config.json, so nothing is sent.
        </p>
      ) : null}

      {missing > 0 ? (
        <p className="note">
          {missing} {missing === 1 ? 'key is' : 'keys are'} missing from .env. Any run that needs{' '}
          {missing === 1 ? 'it' : 'them'} will fail.
        </p>
      ) : null}
    </div>
  );
}
