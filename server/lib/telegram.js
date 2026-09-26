import fs from 'node:fs';
import { config, env } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('telegram');

/** Telegram rejects anything longer, silently truncating or 400ing. */
const MAX_TEXT = 4096;

const enabled = () => Boolean(config.publish.notifyTelegram && env.telegram.botToken && env.telegram.chatId);

const api = (method) => `https://api.telegram.org/bot${env.telegram.botToken}/${method}`;

/**
 * Headlines come from news RSS and routinely contain &, < and >. Unescaped,
 * a single "<" in a title makes the whole send fail with "can't parse entities",
 * so escaping is mandatory rather than cosmetic.
 */
export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

/**
 * Every function here resolves rather than rejects. By the time we notify, the
 * reel is already rendered and saved — a Telegram outage must never fail a run,
 * lose the artifact, or mark the pipeline as broken.
 */
async function call(body, { label } = {}) {
  if (!enabled()) {
    log.debug(`${label}: skipped (notifyTelegram off or not configured)`);
    return { ok: false, skipped: true, reason: 'not-configured' };
  }

  try {
    const res = await fetch(api(body.method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body.payload)
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      const reason = data.description || `HTTP ${res.status}`;
      log.warn(`${label} failed`, { reason });
      return { ok: false, error: reason };
    }

    log.ok(`${label} → chat ${env.telegram.chatId}`, { messageId: data.result?.message_id });
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    log.warn(`${label} failed`, { reason: err.message });
    return { ok: false, error: err.message };
  }
}

export function sendMessage(text) {
  return call({
    method: 'sendMessage',
    payload: {
      chat_id: env.telegram.chatId,
      text: truncate(text),
      parse_mode: 'HTML',
      disable_web_page_preview: false
    }
  }, { label: 'sendMessage' });
}

/** Attaches the mp4. Telegram caps bot uploads at 50 MB; reels are ~10 MB. */
export function sendVideo(videoPath, caption) {
  if (!enabled()) return Promise.resolve({ ok: false, skipped: true, reason: 'not-configured' });
  if (!fs.existsSync(videoPath)) {
    log.warn('sendVideo: file missing', { videoPath });
    return Promise.resolve({ ok: false, error: 'file not found' });
  }

  return (async () => {
    try {
      const form = new FormData();
      form.append('chat_id', env.telegram.chatId);
      form.append('caption', truncate(caption).slice(0, 1024));
      form.append('parse_mode', 'HTML');
      form.append('supports_streaming', 'true');
      form.append('video', new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' }));

      const res = await fetch(api('sendVideo'), { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const reason = data.description || `HTTP ${res.status}`;
        log.warn('sendVideo failed', { reason });
        return { ok: false, error: reason };
      }
      log.ok('sendVideo → chat', { messageId: data.result?.message_id });
      return { ok: true, messageId: data.result?.message_id };
    } catch (err) {
      log.warn('sendVideo failed', { reason: err.message });
      return { ok: false, error: err.message };
    }
  })();
}

const platformNames = (platforms = []) =>
  (platforms || []).map((p) => (p === 'facebook' ? 'Facebook' : 'LinkedIn')).join(' + ') ||
  'no platforms enabled';

/**
 * Body of the "reel is waiting" message. Split from the send so the formatting
 * can be unit tested without a bot token.
 */
export function buildApprovalMessage({ runId, headline, storyTitle, reason, platforms, sourceUrl, dashboardUrl }) {
  return [
    '<b>Reel ready for approval</b>',
    '',
    `<b>${escapeHtml(headline)}</b>`,
    storyTitle ? `<i>${escapeHtml(storyTitle)}</i>` : null,
    reason ? `\n${escapeHtml(reason)}` : null,
    `\nQueued for: ${escapeHtml(platformNames(platforms))}`,
    runId ? `\nRun: <code>${escapeHtml(runId)}</code>` : null,
    dashboardUrl ? `\nApprove in the dashboard: <a href="${escapeHtml(dashboardUrl)}">open</a>` : null
  ].filter((l) => l !== null).join('\n');
}

export function buildPublishMessage({ headline, results, dashboardUrl }) {
  return [
    '<b>Published</b>',
    '',
    `<b>${escapeHtml(headline)}</b>`,
    '',
    ...(results || []).map((r) =>
      r.status === 'posted'
        ? `✅ ${platformNames([r.platform])} — ${escapeHtml(String(r.id ?? 'posted'))}${r.degraded ? ' (text only)' : ''}`
        : `❌ ${platformNames([r.platform])} — ${escapeHtml(r.error || r.status)}`
    ),
    dashboardUrl ? `\n<a href="${escapeHtml(dashboardUrl)}">Open dashboard</a>` : null
  ].filter((l) => l !== null).join('\n');
}

export function buildFailureMessage({ runId, error, dashboardUrl }) {
  return [
    '<b>Pipeline failed</b>',
    '',
    escapeHtml(error || 'unknown error'),
    runId ? `\nRun: <code>${escapeHtml(runId)}</code>` : null,
    dashboardUrl ? `\n<a href="${escapeHtml(dashboardUrl)}">Open dashboard</a>` : null
  ].filter((l) => l !== null).join('\n');
}

/** The run finished and is waiting for a human to approve it. */
export function notifyApprovalNeeded({ runId, headline, storyTitle, sourceUrl, reason, platforms, videoPath, dashboardUrl }) {
  const body = buildApprovalMessage({ runId, headline, storyTitle, reason, platforms, dashboardUrl });
  const text = [
    body,
    sourceUrl ? `\n<a href="${escapeHtml(sourceUrl)}">Source article</a>` : null
  ].filter((l) => l !== null).join('\n');

  return (async () => {
    if (videoPath && fs.existsSync(videoPath)) {
      // The video is the point of the alert, but the body is the caption.
      const sent = await sendVideo(videoPath, body);
      if (sent.ok) return sent;
      // Fall back to text so a failed upload still tells you a reel is waiting.
      log.warn('notifyApprovalNeeded: video send failed, sending text instead');
    }
    return sendMessage(text);
  })();
}

export function notifyPublished({ headline, results, dashboardUrl }) {
  return sendMessage(buildPublishMessage({ headline, results, dashboardUrl }));
}

export function notifyRunFailed({ runId, error, dashboardUrl }) {
  return sendMessage(buildFailureMessage({ runId, error, dashboardUrl }));
}

/**
 * getMe only proves the token parses. This proves the bot can actually deliver
 * to this specific chat — the usual failure is a chat id the bot was never
 * added to, which getMe reports as perfectly healthy.
 */
export async function verifyChat() {
  if (!env.telegram.botToken) return { ok: false, reason: 'bot token not set' };
  if (!env.telegram.chatId) return { ok: false, reason: 'chat id not set' };

  try {
    const res = await fetch(`${api('getChat')}?chat_id=${encodeURIComponent(env.telegram.chatId)}`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) return { ok: false, reason: data.description || `HTTP ${res.status}` };
    const { type, title, username, first_name } = data.result || {};
    return { ok: true, type, label: title || username || first_name || String(type) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
