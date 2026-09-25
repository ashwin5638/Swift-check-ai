# Swift Check AI — MVP

Marine-industry news → one branded 15-second vertical reel per day → Facebook + LinkedIn.
Runs on a $0 stack. **Two LLM calls per run**; everything else is deterministic code.

```
1. News Scout     0 LLM   Google News RSS + GDELT  →  deduped, 15 candidates
2. Event Ranker   1 LLM   one call picks THE story of the day
3. Script Writer  1 LLM   one call returns voiceover + beats + both captions + hashtags
4. Visual Builder 0 LLM   Pexels photo → Playwright overlays → FFmpeg → mp4 + TTS
5. Publisher      0 LLM   Facebook Graph API / LinkedIn Posts API, or queue for approval
```

---

## 1. Install

```bash
npm install
npm run setup          # downloads Chromium for Playwright (~150 MB, one time)
cp .env.example .env   # then paste your keys
```

FFmpeg is **not** required — `ffmpeg-static` ships a binary with the install.
Voiceover uses Microsoft's free Edge TTS endpoint (no key). Music is synthesised
procedurally unless you drop a track at `src/assets/music/track.mp3`.

Minimum keys to produce a reel: `GROQ_API_KEY` and `PEXELS_API_KEY`.
Both are free. Without Pexels the reel falls back to a branded gradient.

Then confirm everything before you rely on it:

```bash
npm run check:keys      # read-only credential validation
npm run check:models    # are the configured models still served by Groq?
```

`check:keys` only ever issues `GET` requests — it never posts, uploads, or
sends a message. It reports three states: `ok`, `warn` (cannot be verified
without side effects, e.g. a `w_member_social` token that has no read scope),
and `fail`.

> **Rotate any key that has been pasted into a chat, a commit, or a shared
> screen.** Moving it into `.env` does not un-expose it.

## 2. Run it

```bash
npm run run:dry        # full chain, renders video, publishes nothing
npm run run            # respects the auto-post flags in config.json
node src/orchestrator.js --no-render    # news + script only (fastest smoke test)
```

Outputs land in `output/<runId>/`:

| File | What it is |
|---|---|
| `<runId>.mp4` | the 1080×1920 reel |
| `<runId>/facebook.txt` | caption, ready to paste |
| `<runId>/linkedin.txt` | caption, ready to paste |
| `<runId>/content.json` | full run record (story, script, beats, timings, token usage) |

## 3. Dashboard

```bash
npm run dev            # API on :4000, React UI on :5173
```

Open http://localhost:5173. Trigger runs, preview the reel, read both captions,
copy them, and one-click approve-and-publish. The list on the left is run history.

## 4. Posting setup

Both platforms are gated by `config.json`:

```jsonc
"publish": {
  "requireApproval": true,      // while true, nothing leaves your machine
  "autoPostFacebook": false,    // set true once the output quality is trusted
  "autoPostLinkedIn": false,
  "linkedinFallbackToText": true,
  "notifyTelegram": true
}
```

`requireApproval` overrides the auto-post flags. Flip it to `false` and set the
per-platform flags to `true` for fully unattended posting.

**Facebook** — developers.facebook.com → create app → add the Pages product →
generate a Page access token (long-lived). The app needs `pages_show_list`,
`pages_read_engagement`, and `pages_manage_posts`. Set:

| Variable | Why |
|---|---|
| `FACEBOOK_APP_ID` | opens the upload session |
| `FACEBOOK_PAGE_ID` | which Page receives the video |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | publishes the video |
| `FACEBOOK_USER_ACCESS_TOKEN` | optional; used for the byte upload, falls back to the Page token |

Publishing uses the current three-step Resumable Upload flow on Graph API
`v26.0`: open a session on `/{APP_ID}/uploads`, `POST` the bytes to
`/upload:{SESSION_ID}` to get a file handle, then publish that handle to
`graph-video.facebook.com/{PAGE_ID}/videos`. The older `/{PAGE_ID}/video_upload`
and `upload_phase` chunking were removed, so older examples found online will
fail. The binary is uploaded directly, so no public URL is needed.

**LinkedIn** — developers.linkedin.com → app → "Sign In with LinkedIn" product →
request `w_member_social`, complete the OAuth flow, then set `LINKEDIN_MEMBER_ID`
(the numeric part of `urn:li:person:<id>`) and `LINKEDIN_ACCESS_TOKEN`.

The Posts API replaced `ugcPosts`. Version is a **header** (`Linkedin-Version:
YYYYMM`), not a path segment. Video goes through the Videos API:
`initializeUpload` → `PUT` each 4 MB part keeping every `ETag` →
`finalizeUpload` → `POST /rest/posts` with the resulting `urn:li:video:` id. The
post id comes back in the `x-restli-id` response header, not the body.

Video posting needs extra app review on most new apps, so
`linkedinFallbackToText` is on by default: if the video upload is rejected the
publisher still creates a text-only post and marks the result `degraded: true`
rather than losing the day's post. Set it to `false` if you would rather it
fail loudly.

**Telegram** — create a bot with @BotFather, message @userinfobot for your chat id.

Add every value as an encrypted repository secret for the GitHub Actions run.

## 5. Daily automation

`.github/workflows/dailyReel.yml` fires at 06:17 UTC. GitHub gives scheduled
workflows 2,000 free minutes/month; this job takes one to three.

One caveat worth knowing: a 15-second video cannot be posted to LinkedIn or
Facebook from a CI runner without a publicly reachable file, and this pipeline
uploads the binary directly instead. That works. It will stop working the moment
you add Instagram Reels, which does require a public `file_url` — you'd add a step
that uploads the mp4 to a public bucket first. Not a problem for this MVP.

## 6. Editing the reel

Everything tunable is in `config.json` — brand colours, reel length, voice,
TTS pitch/rate, the news queries, the models, and which LLM is used for what.

The look lives in `src/templates/frame.html`. It's plain CSS and the file renders
identically in a browser, so you can iterate on the design without restarting
anything. Beat timings are computed in `src/lib/frames.js` — the model only
writes the words, never the timestamps.

## 7. Architecture notes

`src/lib/llm.js` is the only file that imports a vendor SDK. Every agent calls
`chat()`, so moving to OpenRouter, Ollama, or any OpenAI-compatible endpoint is a
one-file change.

The model split is `llm.rankerModel` and `llm.writerModel` in `config.json`.
Both currently point at `qwen/qwen3.8-27b`, which is deliberate — **not** an
oversight. Groq's `gpt-oss-*` family are reasoning models: measured on the real
prompts, `gpt-oss-120b` needed 1,063 output tokens and 2.7 s for the writer call
where `qwen3.8-27b` used 233 tokens and 0.6 s for the same valid JSON. At
`rankerMaxTokens: 200` the reasoning models return *empty* content with
`finish_reason: length`, which is exactly how the pipeline first broke. If you
swap in a reasoning model, raise the token caps and expect the cost.

Model names are config, not code, and Groq retires models with no runtime
signal — `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` were removed in
August 2026. `npm run check:models` is the guard; the workflow runs it before the
pipeline so a retirement fails in seconds with a clear message instead of
mid-render.

`chat()` also degrades instead of dying: if a model rejects
`response_format: json_object` with `json_validate_failed`, it retries once with
prompt-only JSON, and a truncated response raises an error naming the exact
config key to raise.

No database. State is three JSON files under `state/` — a 200-entry dedupe log,
60 run records, and the approval queue. At one reel a day that is years of
headroom before a real database is worth the operational cost.

## 8. Known limitations

- LinkedIn tokens expire (~60 days). Automation will need a refresh-token flow.
- LinkedIn video posting usually needs app review, which is why the publisher
  falls back to a text post and flags the run as `degraded`.
- `FACEBOOK_APP_ID` is required for publishing and cannot be derived from a Page
  access token — it has to come from the app dashboard.
- Stock photos occasionally miss for niche stories; the gradient fallback covers it.
- No performance analytics yet, so the ranker is optimising for impact, not engagement.
- Telegram notification is a config flag but the send helper is not wired into
  `publisher.js` — the dashboard is the approval surface for the MVP.
