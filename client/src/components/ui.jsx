import { IconAlertTriangle, IconInbox } from '@tabler/icons-react';

const ICON = 14;

export function Dot({ tone = 'idle', live = false }) {
  return <span className={`dot ${tone}${live ? ' live' : ''}`} aria-hidden="true" />;
}

export function Tag({ tone = 'idle', icon, children }) {
  return (
    <span className={`tag ${tone}`}>
      {icon}
      {children}
    </span>
  );
}

export function Spec({ k, v, tone }) {
  return (
    <div className="spec-row">
      <span className="k">{k}</span>
      <span className={`v${tone ? ` is-${tone}` : ''}`} title={typeof v === 'string' ? v : undefined}>
        {v ?? '—'}
      </span>
    </div>
  );
}

export function Empty({ icon: Icon = IconInbox, title, children, action }) {
  return (
    <div className="empty">
      <Icon size={26} stroke={1.4} aria-hidden="true" />
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function InlineError({ children, onRetry }) {
  return (
    <div className="inline-err" role="alert">
      <IconAlertTriangle size={ICON} stroke={1.6} aria-hidden="true" />
      <span>{children}</span>
      {onRetry ? (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ count = 4 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="skel-row" key={i} />
      ))}
    </div>
  );
}

export function SectionHead({ title, note, actions }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {actions ?? (note ? <span className="aside-note">{note}</span> : null)}
    </div>
  );
}

/** Placeholder shaped like the run header it replaces, so selecting a run
 *  does not collapse and re-expand the page. */
export function DetailSkeleton() {
  return (
    <div className="skel-stack" aria-hidden="true">
      <div className="skel" style={{ width: 120, height: 16 }} />
      <div className="skel" style={{ width: '76%', height: 22 }} />
      <div className="skel" style={{ width: '58%', height: 12 }} />
      <div className="skel" style={{ width: '100%', height: 190 }} />
      <div className="skel" style={{ width: '88%', height: 12 }} />
    </div>
  );
}
