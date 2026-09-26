/** Formatters. Every figure on screen passes through one of these so the
 *  dashboard and the run log never disagree about units.
 *
 *  All of them return null for input they cannot make sense of, and the views
 *  render that as an em dash. A formatter that prints "NaNd ago" is worse than
 *  one that admits it has nothing to show. */

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function toTime(value) {
  if (!value) return NaN;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

export function fmtDuration(ms) {
  if (!isNum(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

export function fmtBytes(bytes) {
  if (!isNum(bytes) || bytes <= 0) return null;
  const mb = bytes / 1024 / 1024;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function fmtCount(n) {
  if (!isNum(n)) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtClock(value) {
  const t = toTime(value);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleTimeString(undefined, { hour12: false });
}

export function fmtStamp(iso) {
  const t = toTime(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function fmtRelative(iso, now = Date.now()) {
  const t = toTime(iso);
  if (Number.isNaN(t)) return null;
  const secs = Math.round((now - t) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172_800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}
