import fs from 'node:fs';
import { config, env } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('publisher');

const PART_BYTES = 4 * 1024 * 1024;

/**
 * AGENT 5 — Publisher.  Zero LLM calls.
 *
 * Every platform is gated by a config flag. `requireApproval` wins over the
 * auto-post flags: while it is true nothing leaves the machine and the reel is
 * queued for approval in the dashboard instead.
 */
export async function publisher({ runId, script, media, event, force = false, dry = false }) {
  const targets = [];
  const { requireApproval, autoPostFacebook, autoPostLinkedIn } = config.publish;

  if (autoPostFacebook) targets.push('facebook');
  if (autoPostLinkedIn) targets.push('linkedin');

  if (!targets.length) {
    log.warn('No platform enabled. Turn on publish.autoPostFacebook / autoPostLinkedIn in config.json.');
    return { status: 'skipped', reason: 'no-platforms-enabled', results: [] };
  }

  if (dry) {
    log.warn('Dry run — no API calls made.');
    return { status: 'dry-run', results: targets.map((t) => ({ platform: t, status: 'skipped', reason: 'dry-run' })) };
  }

  if (requireApproval && !force) {
    log.info('requireApproval is on — reel queued for manual approval.');
    return { status: 'awaiting-approval', results: targets.map((t) => ({ platform: t, status: 'queued' })) };
  }

  const results = [];
  for (const platform of targets) {
    try {
      const result = platform === 'facebook'
        ? await postToFacebook({ script, media, event })
        : await postToLinkedIn({ script, media, event });
      results.push({ platform, status: 'posted', ...result });
      log.ok(`Posted to ${platform}`, { id: result.id, degraded: result.degraded || false });
    } catch (err) {
      results.push({ platform, status: 'failed', error: err.message });
      log.error(`Failed to post to ${platform}`, { reason: err.message, runId });
    }
  }

  return { status: 'published', results };
}

// ---- Facebook ----------------------------------------------------------
// Graph API v26.0, three steps. The older /{PAGE_ID}/video_upload and the
// chunked upload_phase approach are both removed, so this is the only shape
// that works on current versions.
//
//   1. POST /{APP_ID}/uploads        -> upload session id
//   2. POST /upload:{SESSION_ID}     -> file handle
//   3. POST graph-video /{PAGE_ID}/videos with that handle
//
// Step 3 publishes to the Page, so it authenticates with the Page token. Step 2
// uploads the bytes, which Meta documents against a user token — we prefer
// FACEBOOK_USER_ACCESS_TOKEN and fall back to the Page token.

async function postToFacebook({ script, media, event }) {
  const { appId, pageId, pageAccessToken, userAccessToken, graphVersion } = env.facebook;
  if (!pageId || !pageAccessToken) throw new Error('FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN not set');
  if (!appId) throw new Error('FACEBOOK_APP_ID not set (required to open an upload session)');

  const file = media.videoPath;
  const bytes = fs.readFileSync(file);
  const uploadToken = userAccessToken || pageAccessToken;
  const graph = `https://graph.facebook.com/${graphVersion}`;

  // 1. Open the upload session.
  const sessionQs = new URLSearchParams({
    file_name: file.split(/[\\/]/).pop(),
    file_length: String(bytes.length),
    file_type: 'video/mp4',
    access_token: pageAccessToken
  });
  const sessionRes = await fetch(`${graph}/${appId}/uploads?${sessionQs}`, { method: 'POST' });
  const session = await readGraph(sessionRes, 'open upload session');
  const sessionId = session.id ?? session.h;
  if (!sessionId) throw new Error(`No upload session id returned: ${JSON.stringify(session)}`);

  // 2. Push the bytes, then keep the returned file handle.
  const uploadRes = await fetch(`${graph}/upload:${sessionId}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${uploadToken}`,
      file_offset: '0',
      'Content-Type': 'application/octet-stream'
    },
    body: bytes
  });
  const handle = (await readGraph(uploadRes, 'upload video')).h;
  if (!handle) throw new Error('Upload returned no file handle');

  // 3. Publish. The handle goes in as a form field, not a URL.
  const form = new FormData();
  form.append('access_token', pageAccessToken);
  form.append('title', (script.headline || '').slice(0, 200));
  form.append('description', buildFacebookCaption(script, event));
  form.append('fbuploader_video_file_chunk', handle);

  const publishRes = await fetch(`https://graph-video.facebook.com/${graphVersion}/${pageId}/videos`, {
    method: 'POST',
    body: form
  });
  const video = await readGraph(publishRes, 'publish video');

  return { id: video.id, permalink: video.permalink_url || null };
}

function buildFacebookCaption({ facebookCaption, hashtags }, event) {
  return [facebookCaption, hashtags?.join(' '), event.url]
    .filter(Boolean)
    .join('\n\n')
    .replace(/[<>]/g, '');
}

async function readGraph(res, what) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Facebook ${what} failed: ${data.error?.message || `HTTP ${res.status}`}`);
  }
  return data;
}

// ---- LinkedIn -----------------------------------------------------------
// The Posts API replaced ugcPosts. Version is a header (Linkedin-Version:
// YYYYMM), never a path segment, and video now goes through the Videos API:
//
//   1. POST /rest/videos?action=initializeUpload  -> uploadInstructions + token
//   2. PUT each part, keep every ETag              -> uploadedPartIds
//   3. POST /rest/videos?action=finalizeUpload
//   4. POST /rest/posts                            -> x-restli-id

async function postToLinkedIn({ script, media, event }) {
  const { memberId, accessToken, apiVersion } = env.linkedin;
  if (!memberId || !accessToken) throw new Error('LINKEDIN_MEMBER_ID / LINKEDIN_ACCESS_TOKEN not set');

  const file = media.videoPath;
  const bytes = fs.readFileSync(file);

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Linkedin-Version': apiVersion.replace(/^v/, ''),
    'X-Restli-Protocol-Version': '2.0.0'
  };

  try {
    const videoUrn = await uploadLinkedInVideo({ bytes, headers, memberId });

    const postRes = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        author: `urn:li:person:${memberId}`,
        commentary: buildLinkedInCaption(script, event),
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: []
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
        content: { media: { id: videoUrn, title: (script.headline || '').slice(0, 200) } }
      })
    });
    if (!postRes.ok) throw new Error(`HTTP ${postRes.status} ${await postRes.text()}`);

    const id = postRes.headers.get('x-restli-id');
    return { id, urn: id ? `urn:li:share:${id}` : null, videoUrn, degraded: false };
  } catch (err) {
    // Video posting is gated behind extra app review on most new apps. Rather
    // than lose the daily post entirely, drop to a text post and say so.
    if (!config.publish.linkedinFallbackToText) throw err;

    log.warn(`LinkedIn video post rejected, falling back to a text-only post. reason: ${err.message}`);
    const postRes = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        author: `urn:li:person:${memberId}`,
        commentary: buildLinkedInCaption(script, event),
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: []
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false
      })
    });
    if (!postRes.ok) throw new Error(`text fallback failed: HTTP ${postRes.status} ${await postRes.text()}`);

    const id = postRes.headers.get('x-restli-id');
    return {
      id,
      urn: id ? `urn:li:share:${id}` : null,
      degraded: true,
      reason: `video not permitted for this app, posted text only: ${err.message}`
    };
  }
}

async function uploadLinkedInVideo({ bytes, headers, memberId }) {
  const initRes = await fetch('https://api.linkedin.com/rest/videos?action=initializeUpload', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: `urn:li:person:${memberId}`,
        fileSizeBytes: bytes.length,
        uploadCaption: false,
        uploadThumbnail: false
      }
    })
  });
  if (!initRes.ok) throw new Error(`initializeUpload failed: HTTP ${initRes.status} ${await initRes.text()}`);

  const { value: upload } = await initRes.json();
  const { video, uploadToken, uploadInstructions } = upload || {};
  if (!video || !uploadToken || !uploadInstructions?.length) {
    throw new Error(`initializeUpload returned no upload instructions: ${JSON.stringify(upload)}`);
  }

  const uploadedPartIds = [];
  for (const part of uploadInstructions) {
    const start = part.firstByte;
    const end = part.lastByte;
    const chunk = bytes.subarray(start, end + 1);

    const putRes = await fetch(part.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
      body: chunk
    });
    if (!putRes.ok) throw new Error(`part ${start}-${end} failed: HTTP ${putRes.status} ${await putRes.text()}`);

    const etag = putRes.headers.get('etag');
    if (!etag) throw new Error(`part ${start}-${end} returned no ETag`);
    uploadedPartIds.push(etag);
  }

  const finalRes = await fetch('https://api.linkedin.com/rest/videos?action=finalizeUpload', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      finalizeUploadRequest: { video, uploadToken, uploadedPartIds }
    })
  });
  if (!finalRes.ok) throw new Error(`finalizeUpload failed: HTTP ${finalRes.status} ${await finalRes.text()}`);

  return video;
}

function buildLinkedInCaption({ linkedinCaption, hashtags }, event) {
  return [linkedinCaption, hashtags?.join(' '), event.url ? `Source: ${event.url}` : null]
    .filter(Boolean)
    .join('\n\n');
}

export { postToFacebook, postToLinkedIn };
