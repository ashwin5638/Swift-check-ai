import { useState } from 'react';
import {
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconSend,
  IconVideoOff
} from '@tabler/icons-react';
import StageWaterfall from './StageWaterfall.jsx';
import { SectionHead, Spec, Tag } from './ui.jsx';
import { PLATFORM_LABEL, displayStatus, label, tone } from '../lib/status.js';
import { captionFor } from '../lib/feed.js';
import { fmtBytes, fmtDuration, fmtStamp } from '../lib/format.js';

export default function RunDetail({ run, busy, onPublish, notify }) {
  const [copied, setCopied] = useState(null);

  const media = run.media ?? {};
  const hasMedia = Boolean(media.videoUrl);
  const renderSkipped = media.skipped === true;
  const status = displayStatus(run);
  // Only a reel that is still sitting in the queue can be approved. Judged on
  // the raw run.status, a published run would keep offering the button.
  const needsApproval = hasMedia && status === 'awaiting-approval' && Boolean(onPublish);

  /**
   * Reads the caption out of the run record rather than fetching
   * /api/captions/<id>/<platform>. In read-only mode there is no API, and the
   * record already carries the text — the file the endpoint streams is written
   * from exactly these fields.
   */
  async function copy(platform) {
    const text = captionFor(run, platform);
    if (!text.trim()) return notify('No caption was written for this platform', 'err');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(platform);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      notify('The browser blocked clipboard access. Select the text and copy it manually.', 'err');
    }
  }

  const tokens = (run.llm?.promptTokens || 0) + (run.llm?.completionTokens || 0);
  const results = run.publish?.results ?? [];

  return (
    <div className="stack">
      <header className="runhead">
        <div className="runhead-top">
          <Tag tone={tone(status)}>{label(status)}</Tag>
          {run.dry ? <Tag tone="idle">dry run</Tag> : null}
          {renderSkipped ? <Tag tone="idle">render skipped</Tag> : null}
          <span className="label" style={{ marginLeft: 'auto' }}>
            {run.id}
          </span>
        </div>

        <h1>{run.event?.title ?? run.title ?? 'No story selected'}</h1>
        {run.event?.reason ? <p className="lede">{run.event.reason}</p> : null}

        <div className="runhead-meta">
          {run.event?.source ? <span>Source: {run.event.source}</span> : null}
          {run.event?.url ? (
            <a href={run.event.url} target="_blank" rel="noreferrer">
              Read the source article
              <IconExternalLink size={12} stroke={1.7} style={{ verticalAlign: '-1px', marginLeft: 4 }} />
            </a>
          ) : null}
        </div>

        {needsApproval ? (
          <div className="runhead-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={onPublish}>
              <IconSend size={14} stroke={1.7} />
              Approve and post
            </button>
            <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              The reel is rendered and saved. Approving publishes the file as it stands.
            </span>
          </div>
        ) : null}
      </header>

      {status === 'failed' ? (
        <div className="fault">
          <span className="label">Failure</span>
          <pre>{run.error ?? 'The run failed without recording an error message.'}</pre>
        </div>
      ) : null}

      <section className="section">
        <SectionHead title="Reel preview" note={hasMedia ? null : 'not rendered'} />

        <div className="split">
          <div className="player">
            {hasMedia ? (
              <video
                src={media.videoUrl}
                controls
                playsInline
                preload="metadata"
                aria-label={`Reel preview: ${run.event?.title ?? run.title ?? run.id}`}
              />
            ) : (
              <div className="player-still">
                <IconVideoOff size={22} stroke={1.3} />
                <span style={{ marginTop: 8 }}>
                  {renderSkipped
                    ? 'The render step was skipped for this run, so no reel was produced.'
                    : 'This run produced no video file.'}
                </span>
              </div>
            )}
          </div>

          <div>
            <div className="spec">
              <Spec k="Run" v={run.id} />
              <Spec k="Started" v={fmtStamp(run.startedAt)} />
              <Spec k="Wall time" v={fmtDuration(run.durationMs)} />
              <Spec k="Reel length" v={media.durationSeconds ? `${media.durationSeconds}s` : null} />
              <Spec k="File size" v={fmtBytes(media.sizeBytes)} />
              <Spec
                k="Voiceover"
                v={hasMedia ? (media.hasVoiceover ? 'present' : 'absent') : null}
                tone={hasMedia && !media.hasVoiceover ? 'warn' : hasMedia ? 'ok' : undefined}
              />
              <Spec k="LLM calls" v={run.llm?.calls ?? 0} />
              <Spec k="Tokens" v={tokens.toLocaleString()} />
            </div>

            {results.length ? (
              <>
                <SectionHead
                  title="Publish results"
                  actions={<Tag tone={tone(run.publish?.status)}>{label(run.publish.status)}</Tag>}
                />
                <div className="results">
                  {results.map((r) => (
                    <div className="result-row" key={r.platform}>
                      <span className="p">{(PLATFORM_LABEL[r.platform] ?? r.platform).toUpperCase()}</span>
                      <Tag tone={tone(r.status)}>{label(r.status)}</Tag>
                      <span className="detail" title={resultDetail(r)}>
                        {resultDetail(r)}
                      </span>
                      {r.permalink ? (
                        <a href={r.permalink} target="_blank" rel="noreferrer" aria-label={`Open the ${r.platform} post`}>
                          <IconExternalLink size={14} stroke={1.6} />
                        </a>
                      ) : (
                        <span />
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <StageWaterfall run={run} />

      <section className="section">
        <SectionHead
          title="On-screen beats"
          note={run.beats?.length ? `${run.beats.length} beats` : null}
        />
        {run.beats?.length ? (
          <div className="beats">
            {run.beats.map((b, i) => (
              <div className="beat" key={i}>
                <span className="t">
                  {typeof b === 'string' ? `beat ${i + 1}` : `${b.start}s–${b.end}s`}
                </span>
                <span className="x">{typeof b === 'string' ? b : b.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="note" style={{ marginTop: 0 }}>
            No beats were written for this run.
          </p>
        )}
      </section>

      <section className="section">
        <SectionHead title="Voiceover" />
        {run.script?.voiceover ? (
          <p className="prose">{run.script.voiceover}</p>
        ) : (
          <p className="note" style={{ marginTop: 0 }}>
            No voiceover script was produced.
          </p>
        )}
      </section>

      <section className="section">
        <SectionHead
          title="Captions"
          note={run.script?.hashtags?.length ? `${run.script.hashtags.length} hashtags` : null}
        />
        <div className="captions">
          <Caption
            title="Facebook"
            body={run.script?.facebookCaption}
            hashtags={run.script?.hashtags}
            onCopy={() => copy('facebook')}
            copied={copied === 'facebook'}
          />
          <Caption
            title="LinkedIn"
            body={run.script?.linkedinCaption}
            hashtags={run.script?.hashtags}
            onCopy={() => copy('linkedin')}
            copied={copied === 'linkedin'}
          />
        </div>
      </section>
    </div>
  );
}

function resultDetail(r) {
  if (r.error) return r.error;
  if (r.degraded) return `posted as text only, ${r.id ?? r.urn ?? 'no id'}`;
  if (r.id) return r.id;
  if (r.urn) return r.urn;
  return '—';
}

function Caption({ title, body, hashtags, onCopy, copied }) {
  const tags = hashtags?.join(' ');

  return (
    <div className="caption">
      <div className="caption-head">
        <h3>{title}</h3>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCopy}>
          {copied ? <IconCheck size={13} stroke={2} /> : <IconCopy size={13} stroke={1.6} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        {body || '—'}
        {tags ? <span className="tags">{`\n\n${tags}`}</span> : null}
      </pre>
    </div>
  );
}
