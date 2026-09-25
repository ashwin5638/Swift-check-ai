export default function RunList({ runs, selectedId, onSelect }) {
  if (!runs.length) {
    return <p style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing yet.</p>;
  }

  return (
    <div className="runlist">
      {runs.map((r) => (
        <button
          key={r.id}
          className={`runitem ${r.id === selectedId ? 'active' : ''}`}
          onClick={() => onSelect(r.id)}
        >
          <div className="t">{r.title || r.error || 'No story selected'}</div>
          <div className="m">
            <span>{new Date(r.startedAt).toLocaleDateString()}</span>
            <span className={`badge ${r.status}`}>{r.status}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
