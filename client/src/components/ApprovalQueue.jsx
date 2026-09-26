import { IconInbox, IconPlayerPlay, IconCheck, IconX } from '@tabler/icons-react';
import { Empty, SectionHead, Tag } from './ui.jsx';
import useNow from '../lib/useNow.js';
import { PLATFORM_LABEL } from '../lib/status.js';
import { fmtBytes, fmtRelative } from '../lib/format.js';

/**
 * The approval queue. A reel lands here when config.publish.requireApproval is
 * true: it has already been rendered and saved, and is waiting for a human to
 * decide whether it goes out.
 *
 * The card body is a button so the queue is reachable by keyboard. The actions
 * are siblings of that button, not children, so nothing nests.
 */
export default function ApprovalQueue({ pending, busy, onApprove, onReject, onSelectRun, selectedId }) {
  const now = useNow(15_000);

  return (
    <section>
      <SectionHead
        title="Approval queue"
        actions={
          pending.length ? (
            <Tag tone="warn">{pending.length} waiting</Tag>
          ) : (
            <Tag tone="ok">clear</Tag>
          )
        }
      />

      {!pending.length ? (
        <Empty icon={IconInbox} title="Queue is clear">
          Reels appear here when <code>requireApproval</code> is on and a platform is enabled. By
          then they have already been rendered, so approving publishes the saved file.
        </Empty>
      ) : (
        pending.map((entry) => {
          const active = entry.id === selectedId;
          const platforms = entry.platforms ?? [];
          return (
            <article className={`qcard${active ? ' is-active' : ''}`} key={entry.id}>
              <button
                type="button"
                className="qcard-main"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelectRun(entry.id)}
              >
                <div className="qcard-top">
                  <Tag tone="warn">pending review</Tag>
                  <span className="qcard-platforms">
                    {platforms.map((p) => (
                      <Tag key={p} tone="idle" title={p}>
                        {PLATFORM_LABEL[p] ?? p}
                      </Tag>
                    ))}
                  </span>
                </div>

                <h3>{entry.headline || entry.storyTitle || entry.id}</h3>
                {entry.storyTitle && entry.storyTitle !== entry.headline ? (
                  <p className="qcard-blurb">{entry.storyTitle}</p>
                ) : null}

                <div className="qcard-meta">
                  <span>{fmtRelative(entry.createdAt, now) ?? '—'}</span>
                  {entry.durationSeconds ? <span>{entry.durationSeconds}s reel</span> : null}
                  {entry.sizeBytes ? <span>{fmtBytes(entry.sizeBytes)}</span> : null}
                </div>
              </button>

              <div className="qcard-actions">
                {entry.videoUrl ? (
                  <a
                    className="btn btn-sm btn-ghost"
                    href={entry.videoUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <IconPlayerPlay size={13} stroke={1.6} />
                    Preview
                  </a>
                ) : (
                  <button type="button" className="btn btn-sm btn-ghost" disabled title="This run rendered no video">
                    No preview
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => onApprove(entry.id)}
                >
                  <IconCheck size={14} stroke={2} />
                  Approve &amp; post
                </button>

                <button
                  type="button"
                  className="btn btn-sm btn-ghost btn-danger"
                  disabled={busy}
                  onClick={() => onReject(entry.id)}
                >
                  <IconX size={14} stroke={1.8} />
                  Reject
                </button>
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}
