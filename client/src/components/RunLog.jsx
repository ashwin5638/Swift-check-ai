import { useEffect, useRef, useState } from 'react';
import { IconHistory, IconTrash } from '@tabler/icons-react';
import { Dot, Empty, SkeletonRows } from './ui.jsx';
import { label, tone } from '../lib/status.js';
import { fmtDuration, fmtStamp } from '../lib/format.js';

const CONFIRM_MS = 3000;

/**
 * Run history as a log, not a card stack. The duration figure carries a
 * hairline meter scaled against the slowest run in the current history, so
 * the column stays comparable between polls.
 */
export default function RunLog({ runs, selectedId, onSelect, onDelete, busy, loading, error, onRetry }) {
  // Deleting drops the reel from disk, so the first click only arms the button.
  const [armed, setArmed] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function arm(id) {
    clearTimeout(timer.current);
    setArmed(id);
    timer.current = setTimeout(() => setArmed(null), CONFIRM_MS);
  }

  function handleDelete(id) {
    if (!onDelete) return;
    if (armed !== id) return arm(id);
    clearTimeout(timer.current);
    setArmed(null);
    onDelete(id);
  }

  if (loading) return <SkeletonRows count={5} />;
  if (error) return <div style={{ padding: '0 16px 16px' }}>{error}</div>;

  if (!runs.length) {
    return (
      <div style={{ padding: '0 16px 16px' }}>
        <Empty icon={IconHistory} title="No runs recorded">
          {onDelete
            ? 'Trigger the pipeline above to produce the first reel. Runs are listed newest first.'
            : 'The published feed is empty. It fills in after the first scheduled reel completes.'}
        </Empty>
      </div>
    );
  }

  const slowest = Math.max(...runs.map((r) => r.durationMs || 0), 1);

  return (
    <div className="log">
      <div className="log-head">
        <span />
        <span className="label">Event</span>
        <span className="label">Dur</span>
      </div>

      <ul style={{ listStyle: 'none' }}>
        {runs.map((r) => {
          const active = r.id === selectedId;
          const isArmed = armed === r.id;
          const pct = r.durationMs ? Math.max(5, Math.round((r.durationMs / slowest) * 100)) : 0;
          return (
            <li className={`log-row${active ? ' is-active' : ''}`} key={r.id}>
              <button
                type="button"
                className="log-pick"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(r.id)}
              >
                    <Dot tone={tone(r.status)} live={r.status === 'running'} />
                    <span style={{ minWidth: 0 }}>
                      <span className="log-title">{r.event?.title ?? r.title ?? r.error ?? 'No story selected'}</span>

                  <span className="log-sub">
                    <span className="num">{fmtStamp(r.startedAt)}</span>
                    <span className="sep" aria-hidden="true">
                      /
                    </span>
                    <span>{label(r.status)}</span>
                  </span>
                </span>
              </button>

              <span className="log-cell-wrap">
                <span className="log-dur" style={{ '--w': `${pct}%` }}>
                  {fmtDuration(r.durationMs) ?? '—'}
                </span>
                {/* No delete affordance in read-only mode: the published feed is a
                    build artifact, and a button that cannot work is worse than no
                    button. */}
                {onDelete ? (
                  <button
                    type="button"
                    className={`log-del btn btn-icon${isArmed ? ' is-armed' : ''}`}
                    aria-label={isArmed ? `Confirm delete of run ${r.id}` : `Delete run ${r.id}`}
                    disabled={busy}
                    onClick={() => handleDelete(r.id)}
                  >
                    {isArmed ? 'Sure?' : <IconTrash size={14} stroke={1.6} />}
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
