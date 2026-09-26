import { IconRefresh } from '@tabler/icons-react';
import { Dot } from './ui.jsx';
import useNow from '../lib/useNow.js';
import { fmtClock, fmtRelative } from '../lib/format.js';

const FRESH_MS = 12_000;
const STALE_MS = 30_000;

// A daily feed should never be much older than a day. These are on the scale of
// the schedule, not the poll interval, so they are deliberately separate from
// FRESH_MS/STALE_MS above.
const DATA_LATE_MS = 20 * 3_600_000;
const DATA_STALE_MS = 26 * 3_600_000;

function Item({ label, value, tone, live }) {
  return (
    <div className={`sysitem${tone ? ` is-${tone}` : ''}`}>
      <Dot
        tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'err' ? 'err' : tone === 'accent' ? 'accent' : 'idle'}
        live={live}
      />
      <span className="label">{label}</span>
      <b className="num">{value}</b>
    </div>
  );
}

/**
 * The system strip. It reports the pipeline's own state, not the operator's
 * last click, and it says how stale the numbers are. A console that shows
 * live data without an update time is lying by omission.
 */
export default function TopRail({ health, syncAt, dataAt, syncError, onRefresh }) {
  const now = useNow(1000);
  const publish = health?.config?.publish ?? {};
  const queueDepth = health?.queue?.pending ?? null;

  // Read-only mode has no live pipeline behind it, so the number worth showing
  // is when CI last produced data. Reporting the age of the last fetch instead
  // would read "live" forever while the feed quietly went days stale, which is
  // the one thing this console exists to catch.
  const dataAge = dataAt ? now - new Date(dataAt).getTime() : null;
  const age = dataAt ? dataAge : syncAt ? now - syncAt : null;

  const sync = syncError
    ? { label: 'Sync', value: 'link lost', tone: 'err' }
    : dataAt
      ? dataAge == null || Number.isNaN(dataAge)
        ? { label: 'Data', value: 'unknown', tone: 'warn' }
        : dataAge > DATA_STALE_MS
          ? { label: 'Data', value: 'stale', tone: 'err' }
          : dataAge > DATA_LATE_MS
            ? { label: 'Data', value: fmtRelative(dataAt, now), tone: 'warn' }
            : { label: 'Data', value: fmtRelative(dataAt, now), tone: 'ok' }
      : age == null
        ? { label: 'Sync', value: 'connecting', tone: 'warn' }
        : age > STALE_MS
          ? { label: 'Sync', value: 'stale', tone: 'err' }
          : age > FRESH_MS
            ? { label: 'Sync', value: fmtRelative(new Date(syncAt).toISOString(), now), tone: 'warn' }
            : { label: 'Sync', value: 'live', tone: 'ok' };

  return (
    <header className="zone-top">
      <div className="cr-brand">
        <img src="/logo.svg" alt="" />
        <span className="wordmark">Swift Check AI</span>
        <span className="hairline" />
        <span className="label">{dataAt ? 'Published feed' : 'Control room'}</span>
      </div>

      <div className="sysstate">
        {dataAt ? (
          // No API behind the read-only feed, so pipeline state, queue depth and
          // the auto-post flags are all unknown. Rendering them as "idle", "—"
          // and "off" would assert a configuration nobody can verify, so this
          // mode says what it actually is instead.
          <>
            <Item label="Mode" value="read-only" tone="idle" />
            <Item label="Source" value="CI feed" tone="idle" />
          </>
        ) : (
          <>
            <Item
              label="Pipeline"
              value={health?.running ? 'running' : 'idle'}
              tone={health?.running ? 'accent' : 'idle'}
              live={Boolean(health?.running)}
            />
            <Item label="Queue" value={queueDepth == null ? '—' : queueDepth} tone={queueDepth ? 'warn' : 'idle'} />
            <Item label="FB auto" value={publish.autoPostFacebook ? 'on' : 'off'} tone={publish.autoPostFacebook ? 'ok' : 'idle'} />
            <Item label="LI auto" value={publish.autoPostLinkedin ? 'on' : 'off'} tone={publish.autoPostLinkedin ? 'ok' : 'idle'} />
            <Item
              label="Approval"
              value={publish.requireApproval ? 'required' : 'automatic'}
              tone={publish.requireApproval ? 'warn' : 'idle'}
            />
          </>
        )}
        <Item {...sync} />
      </div>

      <div className="topright">
        <span className="clock num">{fmtClock(now)}</span>
        <button type="button" className="btn btn-icon" onClick={onRefresh} aria-label="Refresh now" title="Refresh now">
          <IconRefresh size={15} stroke={1.6} />
        </button>
      </div>
    </header>
  );
}
