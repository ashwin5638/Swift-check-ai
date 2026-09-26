import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconLayoutDashboard } from '@tabler/icons-react';
import TopRail from './components/TopRail.jsx';
import KpiStrip from './components/KpiStrip.jsx';
import TriggerPanel from './components/TriggerPanel.jsx';
import RunLog from './components/RunLog.jsx';
import RunDetail from './components/RunDetail.jsx';
import ApprovalQueue from './components/ApprovalQueue.jsx';
import Credentials from './components/Credentials.jsx';
import Toasts from './components/Toasts.jsx';
import { DetailSkeleton, Empty, InlineError, SectionHead, Tag } from './components/ui.jsx';
import { READ_ONLY, POLL_MS, loadFeed } from './lib/feed.js';

const TOAST_LIFE = 5000;

/** The API's own `error` string when it sends one, so the toast says what
 *  actually went wrong rather than a bare status code. */
async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [runs, setRuns] = useState([]);
  const [pending, setPending] = useState([]);
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(location.search).get('run'));
  const [detailRun, setDetailRun] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [booted, setBooted] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [syncAt, setSyncAt] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);
  const toastSeq = useRef(0);

  // Read-only mode ships whole records in the feed, so the selected run is
  // already in hand. The API's reduced per-run shape is why the live console
  // needs a second request to fill the detail pane.
  const run = useMemo(
    () => (READ_ONLY ? runs.find((r) => r.id === selectedId) ?? null : detailRun),
    [READ_ONLY, runs, selectedId, detailRun]
  );

  const notify = useCallback((message, kind = 'ok') => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_LIFE);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const poll = useCallback(async () => {
    try {
      if (READ_ONLY) {
        const feed = await loadFeed();
        setRuns(feed.runs);
        setGeneratedAt(feed.generatedAt);
        setLoadError(null);
        setSyncAt(Date.now());
        return;
      }

      const [runsData, pendingData, healthData] = await Promise.all([
        getJson('/api/runs'),
        getJson('/api/pending'),
        getJson('/api/health').catch(() => null)
      ]);
      setRuns(runsData.runs);
      setPending(pendingData.pending);
      if (healthData) setHealth(healthData);
      setLoadError(null);
      setSyncAt(Date.now());
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setBooted(true);
    }
  }, []);

  useEffect(() => {
    poll();
    // The run log is the console's source of truth once a run finishes.
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  // Point the selection at something real. A run that was deleted, or a deep
  // link to a run that no longer exists, falls back to the newest entry.
  useEffect(() => {
    if (!runs.length) return setSelectedId(null);
    if (selectedId && runs.some((r) => r.id === selectedId)) return;
    setSelectedId(runs[0].id);
  }, [runs, selectedId]);

  // Mirror the selection into the URL so a run can be linked to or reloaded.
  useEffect(() => {
    const current = new URLSearchParams(location.search).get('run');
    if ((selectedId ?? null) === (current ?? null)) return;
    const url = new URL(location.href);
    if (selectedId) url.searchParams.set('run', selectedId);
    else url.searchParams.delete('run');
    history.replaceState(null, '', url);
  }, [selectedId]);

  // The detail is fetched on selection only, so a publish would otherwise
  // leave a stale status on screen. Read-only mode skips it: the feed already
  // holds the whole record and a re-poll replaces it.
  const loadDetail = useCallback(async (id) => {
    if (READ_ONLY) return;
    if (!id) {
      setDetailRun(null);
      return;
    }
    setDetailLoading(true);
    try {
      setDetailRun((await getJson(`/api/runs/${id}`)).run);
    } catch {
      setDetailRun(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (READ_ONLY) return;
    let cancelled = false;
    if (!selectedId) {
      setDetailRun(null);
      return;
    }
    fetch(`/api/runs/${selectedId}`)
      .then((r) => (r.ok ? r.json() : { run: null }))
      .then((d) => {
        if (!cancelled) setDetailRun(d.run);
      })
      .catch(() => {
        if (!cancelled) setDetailRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selectRun = useCallback((id) => setSelectedId(id), []);

  /**
   * Runs one action with the shared busy lock, then resyncs.
   *
   * There is no auth round-trip to recover from: a failure is reported as itself.
   */
  const act = useCallback(
    async (work, onOk) => {
      setBusy(true);
      try {
        const data = await work();
        onOk?.(data);
        await Promise.all([poll(), selectedId ? loadDetail(selectedId) : null]);
      } catch (err) {
        notify(err.message, 'err');
      } finally {
        setBusy(false);
      }
    },
    [notify, poll, loadDetail, selectedId]
  );

  // The three actions below are dispatched to GitHub Actions rather than run
  // inline, so their responses are 202s with no result attached. The local API
  // still answers them synchronously, which is why each branch handles both
  // shapes rather than assuming the slow one.

  const startRun = useCallback(
    (options) =>
      act(
        () =>
          getJson('/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options)
          }),
        (data) => notify(data.message || 'Pipeline started. Rendering takes one to two minutes.')
      ),
    [act, notify]
  );

  const publish = useCallback(
    () =>
      act(
        () =>
          getJson(`/api/runs/${run.id}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          }),
        (data) => reportOutcome(notify, data, 'Publishing')
      ),
    [act, notify, run?.id]
  );

  const approve = useCallback(
    (id) =>
      act(
        () =>
          getJson(`/api/pending/${id}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          }),
        (data) => {
          reportOutcome(notify, data, 'Publishing');
          setSelectedId(id);
        }
      ),
    [act, notify]
  );

  const reject = useCallback(
    (id) =>
      act(
        () =>
          getJson(`/api/pending/${id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          }),
        () => notify('Rejected. Nothing was published and the reel is still on disk.')
      ),
    [act, notify]
  );

  const removeRun = useCallback(
    (id) =>
      act(
        () => getJson(`/api/runs/${id}`, { method: 'DELETE' }),
        () => notify('Run deleted. The reel and its history entry are gone.')
      ),
    [act, notify]
  );

  return (
    <div className="cr">
      <TopRail
        health={health}
        syncAt={syncAt}
        dataAt={generatedAt}
        syncError={loadError}
        onRefresh={poll}
      />

      <aside className="zone-rail" aria-label="Pipeline controls and run history">
        <div className="rail-group">
          <KpiStrip runs={runs} />
        </div>

        {READ_ONLY ? null : (
          <TriggerPanel onRun={startRun} busy={busy} running={Boolean(health?.running)} />
        )}

        <div className="rail-group">
          <div className="rail-head">
            <h2 className="label">Run log</h2>
            <Tag tone="idle">{runs.length}</Tag>
          </div>
          <RunLog
            runs={runs}
            selectedId={selectedId}
            onSelect={selectRun}
            onDelete={READ_ONLY ? null : removeRun}
            busy={busy}
            loading={!booted}
            error={loadError ? <InlineError onRetry={poll}>{loadError}</InlineError> : null}
          />
        </div>
      </aside>

      <main className="zone-main">
        <div className="zone-pad">
          {run ? (
            <RunDetail run={run} busy={busy} onPublish={READ_ONLY ? null : publish} notify={notify} />
          ) : detailLoading ? (
            <DetailSkeleton />
          ) : (
            <Empty icon={IconLayoutDashboard} title={booted ? 'No run selected' : 'Reading the published feed'}>
              {booted
                ? READ_ONLY
                  ? 'No runs have been published yet. The feed fills in after the first scheduled reel.'
                  : 'The run log is empty. Trigger the pipeline to produce the first reel.'
                : READ_ONLY
                  ? 'Reading the run history published by CI.'
                  : 'Reading run state from the API.'}
            </Empty>
          )}
        </div>
      </main>

      <aside className="zone-aside" aria-label="Approvals and credentials">
        <div className="zone-pad stack">
          {READ_ONLY ? null : (
            <>
              <ApprovalQueue
                pending={pending}
                busy={busy}
                onApprove={approve}
                onReject={reject}
                onSelectRun={selectRun}
                selectedId={selectedId}
              />

              {/* Never rendered in read-only mode. It exposes no secret values,
                  but on a public URL it still tells every visitor which of the
                  eleven API keys are configured, which is reconnaissance worth
                  more than the panel is worth.

                  The deployed control plane reports `credentials: null` rather
                  than a map of booleans, because the keys are in GitHub Actions
                  secrets and absent from the function — a map of eleven `false`
                  would read as "this project is broken". */}
              <section className="section">
                <SectionHead
                  title="Credentials"
                  actions={
                    health?.credentials ? (
                      <Tag
                        tone={
                          Object.values(health.credentials).every(Boolean) ? 'ok' : 'warn'
                        }
                      >
                        {Object.values(health.credentials).filter(Boolean).length} of{' '}
                        {Object.keys(health.credentials).length}
                      </Tag>
                    ) : null
                  }
                />
                <Credentials health={health} />
              </section>
            </>
          )}
        </div>
      </aside>

      <Toasts toasts={toasts} lifeMs={TOAST_LIFE} onDismiss={dismiss} />
    </div>
  );
}

/**
 * A publish either came back with results — the local API, which ran it inline —
 * or with a 202, meaning it was handed to CI and nothing has happened yet. The
 * second case is not a result and must not be phrased as one; "published" would
 * be a lie for the next three minutes.
 */
function reportOutcome(notify, data, verb) {
  if (data.publish) return reportPublish(notify, data.publish);
  notify(data.message || `${verb} queued in GitHub Actions. Watch it finish in the Actions tab.`);
}

function reportPublish(notify, publish) {
  if (publish?.status === 'skipped' && publish.reason === 'no-platforms-enabled') {
    notify(publish.hint || 'No platform is enabled in config.json.', 'err');
    return;
  }
  const results = publish?.results ?? [];
  if (!results.length) return notify(`Publish status: ${publish?.status ?? 'unknown'}`);
  notify(results.map((r) => `${r.platform} ${r.status}`).join(' · '));
}
