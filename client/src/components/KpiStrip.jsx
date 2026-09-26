import { summariseRuns } from '../lib/status.js';
import { fmtCount, fmtDuration } from '../lib/format.js';

function Cell({ label, value, sub, tone }) {
  return (
    <div className="kpi-cell">
      <span className="label">{label}</span>
      <div className={`kpi-v${tone ? ` is-${tone}` : ''}`}>{value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

const DASH = '—';

/** The instrument cluster. Six figures, all computed from the run history the
 *  server returned. A console with no history shows dashes, never zeroes. */
export default function KpiStrip({ runs }) {
  const s = summariseRuns(runs);

  const passValue = s.passed == null ? DASH : `${Math.round(s.passed * 100)}%`;
  const passTone = s.passed == null ? 'none' : s.passed === 1 ? 'ok' : s.passed >= 0.5 ? 'warn' : 'err';
  const settled = runs.filter((r) => r.finishedAt).length;

  return (
    <div className="kpi">
      <Cell label="Runs" value={s.total} sub="in history" />
      <Cell label="Pass rate" value={passValue} sub={settled ? `${settled} settled` : 'none settled'} tone={passTone} />
      <Cell
        label="Avg run"
        value={s.avgMs == null ? DASH : fmtDuration(s.avgMs)}
        sub="wall time"
        tone={s.avgMs == null ? 'none' : undefined}
      />
      <Cell
        label="Failed"
        value={s.failed}
        sub={s.failed ? 'needs a look' : 'none recorded'}
        tone={s.failed ? 'err' : undefined}
      />
      <Cell label="LLM calls" value={fmtCount(s.calls) ?? DASH} sub="across history" />
      <Cell label="Tokens" value={fmtCount(s.tokens) ?? DASH} sub="in and out" />
    </div>
  );
}
