import { useState } from 'react';

export default function RunDetail({ run, busy, onPublish, notify }) {
  const [copied, setCopied] = useState(null);
  const hasMedia = Boolean(run.media?.videoUrl);
  const needsApproval = run.status === 'awaiting-approval' || (hasMedia && run.publishStatus !== 'published');

  async function copy(platform) {
    const res = await fetch(`/api/captions/${run.id}/${platform}`);
    const text = res.ok ? await res.text() : '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(platform);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      notify('Clipboard blocked by the browser — select the text manually', 'err');
    }
  }

  return (
    <div>
      {hasMedia && (
        <div className="panel">
          <h2>Reel preview</h2>
          <div className="player-wrap">
            <div className="player">
              <video src={run.media.videoUrl} controls playsInline preload="metadata" />
            </div>

            <div>
              <h3 className="story">{run.event?.title}</h3>
              {run.event?.reason && <p className="reason">{run.event.reason}</p>}
              {run.event?.url && (
                <a className="source" href={run.event.url} target="_blank" rel="noreferrer">
                  Read the source article ↗
                </a>
              )}

              <div className="meta-grid">
                <div className="meta">
                  <div className="k">Duration</div>
                  <div className="v">{run.media.durationSeconds}s</div>
                </div>
                <div className="meta">
                  <div className="k">Size</div>
                  <div className="v">{(run.media.sizeBytes / 1024 / 1024).toFixed(1)} MB</div>
                </div>
                <div className="meta">
                  <div className="k">Voiceover</div>
                  <div className="v">{run.media.hasVoiceover ? 'Yes' : 'No'}</div>
                </div>
                <div className="meta">
                  <div className="k">LLM calls</div>
                  <div className="v">{run.llm?.calls ?? 0}</div>
                </div>
                <div className="meta">
                  <div className="k">Tokens</div>
                  <div className="v">{((run.llm?.promptTokens || 0) + (run.llm?.completionTokens || 0)).toLocaleString()}</div>
                </div>
              </div>

              {needsApproval && (
                <button
                  className="btn-primary"
                  style={{ marginTop: 16 }}
                  disabled={busy}
                  onClick={onPublish}
                >
                  Approve &amp; post now
                </button>
              )}

              {run.publish?.results?.length > 0 && (
                <div className="beats" style={{ marginTop: 16 }}>
                  {run.publish.results.map((r) => (
                    <div className="beat" key={r.platform}>
                      <span className="t">{r.platform}</span>
                      <span className="x">
                        {r.status}
                        {r.error ? ` — ${r.error}` : ''}
                        {r.id ? ` · ${r.id}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>On-screen beats</h2>
        <div className="beats">
          {(run.beats || []).map((b, i) => (
            <div className="beat" key={i}>
              {typeof b === 'string' ? <span className="t">beat {i + 1}</span> : <span className="t">{b.start}s–{b.end}s</span>}
              <span className="x">{typeof b === 'string' ? b : b.text}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>Voiceover script</h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--muted)' }}>
          {run.script?.voiceover || '—'}
        </p>
      </div>

      <div className="panel">
        <h2>Captions</h2>
        <div className="player-wrap" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Caption title="Facebook" body={run.script?.facebookCaption} hashtags={run.script?.hashtags} onCopy={() => copy('facebook')} copied={copied === 'facebook'} />
          <Caption title="LinkedIn" body={run.script?.linkedinCaption} hashtags={run.script?.hashtags} onCopy={() => copy('linkedin')} copied={copied === 'linkedin'} />
        </div>
      </div>

      {run.status === 'failed' && (
        <div className="panel" style={{ borderColor: 'var(--error)' }}>
          <h2 style={{ color: 'var(--error)' }}>Failure</h2>
          <p style={{ fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>{run.error}</p>
        </div>
      )}
    </div>
  );
}

function Caption({ title, body, hashtags, onCopy, copied }) {
  const full = [body, hashtags?.join(' ')].filter(Boolean).join('\n\n');
  return (
    <div className="caption">
      <h2 style={{ marginBottom: 8 }}>{title}</h2>
      <button className="btn-ghost copy" onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</button>
      <pre>{full || '—'}</pre>
    </div>
  );
}
