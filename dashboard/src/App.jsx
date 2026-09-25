import { useCallback, useEffect, useState } from 'react';
import RunList from './components/RunList.jsx';
import RunDetail from './components/RunDetail.jsx';

export default function App() {
  const [health, setHealth] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const notify = useCallback((message, kind = 'ok') => {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const loadRuns = useCallback(async () => {
    const res = await fetch('/api/runs');
    if (!res.ok) return;
    const data = await res.json();
    setRuns(data.runs);
    setSelectedId((prev) => prev ?? data.runs[0]?.id ?? null);
  }, []);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    loadRuns();
    // The list is the dashboard's source of truth after a run finishes.
    const timer = setInterval(loadRuns, 5000);
    return () => clearInterval(timer);
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedId) return setRun(null);
    fetch(`/api/runs/${selectedId}`)
      .then((r) => (r.ok ? r.json() : { run: null }))
      .then((d) => setRun(d.run))
      .catch(() => setRun(null));
  }, [selectedId]);

  async function startRun(options) {
    setBusy(true);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Run rejected');
      notify('Pipeline started — this takes 1-2 minutes');
      setTimeout(loadRuns, 4000);
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${run.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Publish failed');
      notify(`Posted: ${data.publish.results.map((r) => `${r.platform} ${r.status}`).join(', ')}`);
      loadRuns();
      const fresh = await fetch(`/api/runs/${run.id}`).then((r) => r.json());
      setRun(fresh.run);
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.svg" alt="Swift Check AI" />
          <div>
            <h1>Swift Check AI</h1>
            <p>Marine reel automation · control room</p>
          </div>
        </div>
        <div className="panel" style={{ padding: '10px 14px' }}>
          <div className="cred" style={{ gap: 16 }}>
            <span>Auto-post</span>
            <span className={health?.config?.publish?.autoPostFacebook ? 'pill on' : 'pill off'}>
              FB {health?.config?.publish?.autoPostFacebook ? 'ON' : 'OFF'}
            </span>
            <span className={health?.config?.publish?.autoPostLinkedin ? 'pill on' : 'pill off'}>
              LI {health?.config?.publish?.autoPostLinkedin ? 'ON' : 'OFF'}
            </span>
            <span className={health?.config?.publish?.requireApproval ? 'pill on' : 'pill off'}>
              {health?.config?.publish?.requireApproval ? 'APPROVAL REQUIRED' : 'AUTO PUBLISH'}
            </span>
          </div>
        </div>
      </header>

      <div className="layout">
        <aside>
          <div className="panel">
            <h2>Trigger run</h2>
            <div className="btn-row">
              <button className="btn-primary" disabled={busy} onClick={() => startRun({})}>
                Run full pipeline
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => startRun({ dry: true })}>
                Run dry (no publishing)
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => startRun({ skipRender: true })}>
                News + script only
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>Credentials</h2>
            <div className="creds">
              {Object.entries(health?.credentials || {}).map(([key, ok]) => (
                <div className="cred" key={key}>
                  <span>{key}</span>
                  <span className={ok ? 'pill on' : 'pill off'}>{ok ? 'SET' : 'MISSING'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2>Run history</h2>
            <RunList runs={runs} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
        </aside>

        <main>
          {run ? (
            <RunDetail run={run} busy={busy} onPublish={publish} notify={notify} />
          ) : (
            <div className="panel empty">
              <h3>No run selected</h3>
              <p>Trigger the pipeline to generate today's reel.</p>
            </div>
          )}
        </main>
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </div>
  );
}
