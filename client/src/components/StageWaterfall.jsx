import { SectionHead } from './ui.jsx';
import { fmtDuration } from '../lib/format.js';

const MIN_BAR = 1.4;

/**
 * The run's telemetry, drawn as a gantt against total wall time. Always present
 * in state/runs.json — the fastest way to see where a run spent its time.
 */
export default function StageWaterfall({ run }) {
  const steps = run.steps ?? [];

  return (
    <section className="section">
      <SectionHead
        title="Pipeline"
        note={steps.length ? `${steps.length} stages` : 'no telemetry'}
      />

      {!steps.length ? (
        <p className="note" style={{ marginTop: 0 }}>
          No per-stage timings were recorded for this run.
        </p>
      ) : (
        <div className="wf">
          <div className="wf-head">
            <span className="label">T+</span>
            <span className="label">Agent</span>
            <span className="label">Wall time</span>
            <span className="label">Dur</span>
            <span className="label">Output</span>
          </div>

          {rows(steps).map((s) => (
            <div
              className={`wf-row${s.dominant ? ' is-dominant' : ''}`}
              key={`${s.agent}-${s.startMs}`}
            >
              <span className="t0">{fmtDuration(s.startMs) ?? '0ms'}</span>
              <span className="agent">{s.agent}</span>
              <div
                className="wf-track"
                role="img"
                aria-label={`${s.agent} took ${fmtDuration(s.ms)}, ${Math.round(s.share)} percent of the run`}
              >
                <span
                  className="wf-bar"
                  style={{ left: `${s.offsetPct}%`, width: `${s.widthPct}%` }}
                />
              </div>
              <span className="ms">{fmtDuration(s.ms)}</span>
              <span className="note">
                {s.llmCalls > 0 ? (
                  <span className="wf-llm">
                    {s.llmCalls} llm
                  </span>
                ) : null}
                <span className="wf-note-text" title={s.detail}>
                  {s.detail ?? '—'}
                </span>
              </span>
            </div>
          ))}

          <div className="wf-foot">
            <span>
              <span className="label">Total</span>
              <span className="num">{fmtDuration(run.durationMs) ?? '—'}</span>
            </span>
            <span>
              <span className="label">LLM</span>
              <span className="num">
                {run.llm?.calls ?? 0} calls,{' '}
                {(run.llm?.promptTokens ?? 0) + (run.llm?.completionTokens ?? 0)} tokens
              </span>
            </span>
            {run.dry ? (
              <span>
                <span className="label">Mode</span>
                <span className="num">dry</span>
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/** Offsets each bar by its cumulative start so the row reads as a timeline
 *  rather than a bar chart, and flags the single stage that dominated. */
function rows(steps) {
  const total = steps.reduce((n, s) => n + (s.ms || 0), 0) || 1;
  const slowest = Math.max(...steps.map((s) => s.ms || 0), 1);
  let cursor = 0;

  return steps.map((s) => {
    const ms = s.ms || 0;
    const row = {
      agent: s.agent,
      detail: s.detail,
      llmCalls: s.llmCalls || 0,
      ms,
      startMs: cursor,
      share: (ms / total) * 100,
      offsetPct: (cursor / total) * 100,
      widthPct: Math.max(MIN_BAR, (ms / total) * 100),
      dominant: ms === slowest
    };
    cursor += ms;
    return row;
  });
}
