import fs from 'node:fs';
import path from 'node:path';
import { config, env } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { addPendingPost } from '../lib/state.js';

const log = createLogger('publisher');

/**
 * AGENT 5 — Publisher.  Zero LLM calls.
 *
 * Every platform is gated by a config flag. `requireApproval` wins over the
 * auto-post flags: while it is true nothing leaves the machine and the reel is
 * queued for approval in the dashboard instead.
 */
export async function publisher({ runId, script, media, event, force = false, dry = false, platforms }) {
  // `platforms` overrides the config flags. The approval queue stores which
  // platforms a reel was queued for, so approving it later posts exactly there
  // even if the config has changed since.
  const { requireApproval, autoPostFacebook, autoPostLinkedIn } = config.publish;

  const targets = platforms
    ? [...platforms]
    : [autoPostFacebook && 'facebook', autoPostLinkedIn && 'linkedin'].filter(Boolean);

  if (!targets.length) {
    log.warn('No platform enabled. Turn on publish.autoPostFacebook / autoPostLinkedIn in config.json.');
    return {
      status: 'skipped',
      reason: 'no-platforms-enabled',
      results: [],
      hint: 'Set publish.autoPostFacebook or publish.autoPostLinkedIn to true in config.json — nothing is queued until a target is enabled.'
    };
  }

  if (dry) {
    log.warn('Dry run — no API calls made.');
    return { status: 'dry-run', results: targets.map((t) => ({ platform: t, status: 'skipped', reason: 'dry-run' })) };
  }

  if (requireApproval && !force) {
    const entry = addPendingPost({
      runId,
      platforms: targets,
      headline: script?.headline || null,
      storyTitle: event?.title || null,
      sourceUrl: event?.url || null,
      reason: event?.reason || null,
      videoUrl: media?.videoUrl || null,
      durationSeconds: media?.durationSeconds || null,
      sizeBytes: media?.sizeBytes || null
    });
    log.info('requireApproval is on — reel queued for approval.', {
      runId,
      platforms: targets.join('+'),
      queueId: entry.id
    });
    return {
      status: 'awaiting-approval',
      results: targets.map((t) => ({ platform: t, status: 'queued' })),
      queueId: entry.id,
      queuedPlatforms: targets
    };
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

  // One platform failing must not be reported as a clean publish, otherwise
  // callers (and Telegram notifications) would claim it went out.
  const posted = results.filter((r) => r.status === 'posted').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const status = failed === 0 ? 'published' : posted === 0 ? 'failed' : 'partial';

  return { status, posted, failed, results };
}

// ---- Facebook ----------------------------------------------------------
// Two ways to get a local mp4 onto a Page, tried in this order.
//
// 1. One multipart POST to /{PAGE_ID}/videos with the file in the `file` field.
//    The default in Meta's own SDKs and the only path that reliably yields a
//    complete video from a file on disk.
//
// 2. The Resumable Upload API from the Video API guide:
//      a. POST /{APP_ID}/uploads      -> upload session id   (user token)
//      b. POST /upload:{SESSION_ID}   -> file handle         (user token)
//      c. POST graph-video /{PAGE_ID}/videos with that handle (page token)
//
// Path 2 is only a fallback, and it is broken for anything over a few MB: step b
// splits the file server-side and returns ONE HANDLE PER PART, newline separated.
// A 9 MB reel comes back as four handles, and /videos cannot assemble them — the
// joined string fails with (#100) "file handle created for another user", and a
// single one silently publishes only that part as a few-second clip. So a
// multi-part handle is reported rather than sent.
//
// Both paths publish with the Page token: a user token is only accepted for the
// upload steps, and the page token is the identity the post is made as.

async function postToFacebook({ script, media, event }) {
  const { appId, pageId, pageAccessToken, userAccessToken, graphVersion } = env.facebook;
  if (!pageId || !pageAccessToken) throw new Error('FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN not set');
  if (!appId) throw new Error('FACEBOOK_APP_ID not set (required to open an upload session)');

  const file = media.videoPath;
  const bytes = fs.readFileSync(file);
  const title = (script.headline || '').slice(0, 200);
  const description = buildFacebookCaption(script, event);
  const graph = `https://graph.facebook.com/${graphVersion}`;

  try {
    const video = await publishFacebookMultipart({ graph, pageId, pageAccessToken, file, bytes, title, description });
    return { id: video.id, permalink: video.permalink_url || null, method: 'multipart' };
  } catch (err) {
    log.warn('Facebook multipart upload failed, falling back to the resumable upload API', {
      reason: err.message
    });
  }

  const video = await publishFacebookResumable({
    graph, graphVersion, appId, pageId, pageAccessToken, userAccessToken, file, bytes, title, description
  });
  return { id: video.id, permalink: video.permalink_url || null, method: 'resumable' };
}

/** One request, whole file, Page token. No session and no file handle. */
async function publishFacebookMultipart({ graph, pageId, pageAccessToken, file, bytes, title, description }) {
  const form = new FormData();
  form.append('access_token', pageAccessToken);
  form.append('title', title);
  form.append('description', description);
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), path.basename(file));

  const res = await fetch(`${graph}/${pageId}/videos`, { method: 'POST', body: form });
  return readGraph(res, 'publish video (multipart)');
}

/** Meta's documented three-step resumable flow. */
async function publishFacebookResumable({
  graph, graphVersion, appId, pageId, pageAccessToken, userAccessToken, file, bytes, title, description
}) {
  const uploadToken = userAccessToken || pageAccessToken;

  // 1. Open the upload session.
  const sessionQs = new URLSearchParams({
    file_name: path.basename(file),
    file_length: String(bytes.length),
    file_type: 'video/mp4',
    access_token: uploadToken
  });
  const sessionRes = await fetch(`${graph}/${appId}/uploads?${sessionQs}`, { method: 'POST' });
  const session = await readGraph(sessionRes, 'open upload session');
  const rawSessionId = session.id ?? session.h;
  if (!rawSessionId) throw new Error(`No upload session id returned: ${JSON.stringify(session)}`);

  // The id already carries the `upload:` prefix (e.g. `upload:MTphdHRhY2htZW50…`).
  // Prepending it again yields `/upload:upload:…`, which fails the HMAC check with
  // a 400. Strip it, then add exactly one prefix.
  const sessionId = String(rawSessionId).replace(/^upload:/, '');

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

  // More than one line means Meta chunked the file and returned a handle per part.
  // /videos cannot join them, so say that instead of failing later with an opaque
  // ownership error.
  const parts = String(handle).split('\n').filter(Boolean);
  if (parts.length > 1) {
    throw new Error(
      `Facebook split the ${(bytes.length / 1024 / 1024).toFixed(1)} MB upload into ${parts.length} parts ` +
      `and returned one file handle per part, which /{PAGE_ID}/videos cannot reassemble. ` +
      `This reel has to go out via the multipart path.`
    );
  }

  // 3. Publish. The handle goes in as a form field, not a URL.
  const form = new FormData();
  form.append('access_token', pageAccessToken);
  form.append('title', title);
  form.append('description', description);
  form.append('fbuploader_video_file_chunk', handle);

  const publishRes = await fetch(`https://graph-video.facebook.com/${graphVersion}/${pageId}/videos`, {
    method: 'POST',
    body: form
  });
  return readGraph(publishRes, 'publish video (resumable)');
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
    // The trace id is the only thing Meta support can act on, and the subcode
    // separates a permission problem from a malformed request.
    const err = data.error || {};
    const sub = err.error_subcode ? ` (subcode ${err.error_subcode})` : '';
    const trace = err.fbtrace_id ? ` [fbtrace ${err.fbtrace_id}]` : '';
    throw new Error(`Facebook ${what} failed: ${err.message || `HTTP ${res.status}`}${sub}${trace}`);
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

    return { ...shareFromHeader(postRes), videoUrn, degraded: false };
  } catch (err) {
    // Video posting needs extra app review on most new apps. Rather than lose the
    // daily post entirely, drop to a text post and say so.
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

    if (!postRes.ok) {
      const status = postRes.status;
      const body = (await postRes.text()).trim();
      // A 401/403 here is the token, not the video. LinkedIn answers those with an
      // empty body, so name what to check instead of leaving the real cause buried
      // under the video failure.
      if (status === 401 || status === 403) {
        throw new Error(
          `LinkedIn text post rejected: HTTP ${status}${body ? ` ${body}` : ' (empty body)'} — ` +
          `the token cannot post as urn:li:person:${memberId}. Check that LINKEDIN_MEMBER_ID is this ` +
          `token's own member id and that the token was granted w_member_social. ` +
          `Run "npm run linkedin:whoami" for a read-only check. Video path was: ${err.message}`
        );
      }
      throw new Error(`text fallback failed: HTTP ${status} ${body}`);
    }

    return { ...shareFromHeader(postRes), degraded: true, reason: `video not permitted for this app, posted text only: ${err.message}` };
  }
}

/** x-restli-id comes back as a bare numeric id or a full URN depending on the
 *  endpoint, so only add the urn:li:share: prefix when it is missing. */
function shareFromHeader(res) {
  const id = res.headers.get('x-restli-id');
  if (!id) return { id: null, urn: null };
  return { id, urn: id.startsWith('urn:li:') ? id : `urn:li:share:${id}` };
}

async function uploadLinkedInVideo({ bytes, headers, memberId }) {
  const initRes = await fetch('https://api.linkedin.com/rest/videos?action=initializeUpload', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: `urn:li:person:${memberId}`,
        fileSizeBytes: bytes.length,
        // Plural. The singular `uploadCaption` is rejected outright by the Videos
        // API with "unrecognized field found but not allowed".
        uploadCaptions: false,
        uploadThumbnail: false
      }
    })
  });
  if (!initRes.ok) {
    const body = (await initRes.text()).trim();
    // 401/403 here is the token, not the video: the request was well formed but the
    // app may not upload. Name the missing scope, since LinkedIn returns an empty
    // body for it.
    if (initRes.status === 401 || initRes.status === 403) {
      throw new Error(
        `initializeUpload rejected: HTTP ${initRes.status}${body ? ` ${body}` : ' (empty body)'} — ` +
        `the token is not authorised for the Videos API. The LinkedIn app must have the ` +
        `"Share on LinkedIn" product and the token must be minted with w_member_social. ` +
        `Run "npm run linkedin:whoami"`
      );
    }
    throw new Error(`initializeUpload failed: HTTP ${initRes.status} ${body}`);
  }

  const { value: upload } = await initRes.json();
  const { video, uploadToken = '', uploadInstructions } = upload || {};
  // LinkedIn answers with "uploadToken": "" for member tokens. The field must be
  // present in finalizeUpload but its value may be empty, so not a truthiness test.
  if (!video || !uploadInstructions?.length) {
    const keys = upload ? Object.keys(upload).join(', ') : '(no value object)';
    throw new Error(
      `initializeUpload returned no upload instructions; response keys: ${keys}`
    );
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
