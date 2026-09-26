import { IconPlayerPlayFilled, IconFlask, IconScript } from '@tabler/icons-react';

/** Manual pipeline triggers. One primary, two variants. The three actions are
 *  distinct in what they do downstream, so each keeps its own label. */
export default function TriggerPanel({ onRun, busy, running }) {
  const locked = busy || running;

  return (
    <div className="rail-group">
      <div className="rail-head">
        <h2 className="label">Trigger</h2>
        {running ? <span className="label" style={{ color: 'var(--accent)' }}>in progress</span> : null}
      </div>

      <div className="rail-body">
        <div className="triggers">
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={locked}
            onClick={() => onRun({})}
          >
            <IconPlayerPlayFilled size={13} stroke={1.4} />
            Run pipeline
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-block"
            disabled={locked}
            onClick={() => onRun({ dry: true })}
          >
            <IconFlask size={15} stroke={1.5} />
            Run dry
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-block"
            disabled={locked}
            onClick={() => onRun({ skipRender: true })}
          >
            <IconScript size={15} stroke={1.5} />
            Script only
          </button>
        </div>

        <p className="trigger-note">
          Run dry publishes nothing. Script only stops before rendering, so no frames or audio are
          produced.
        </p>
      </div>
    </div>
  );
}
