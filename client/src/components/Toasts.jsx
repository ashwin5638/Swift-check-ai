import { IconCircleCheck, IconAlertTriangle, IconX } from '@tabler/icons-react';

const ICON = 15;

/** Transient operator feedback. A live region, so a screen reader announces a
 *  failed publish without the message having to be hunted for. */
export default function Toasts({ toasts, lifeMs, onDismiss }) {
  if (!toasts.length) return null;

  return (
    <div className="toast-layer" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.kind === 'err' ? IconAlertTriangle : IconCircleCheck;
        return (
          <div className={`toast is-${t.kind}`} key={t.id}>
            <Icon className="ti" size={ICON} stroke={1.7} aria-hidden="true" />
            <p>{t.message}</p>
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss message"
            >
              <IconX size={13} stroke={1.8} />
            </button>
            <span className="toast-life" style={{ animationDuration: `${lifeMs}ms` }} />
          </div>
        );
      })}
    </div>
  );
}
