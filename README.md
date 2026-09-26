# Swift Check AI

Marine-industry news → one branded 15-second vertical reel per day → Facebook + LinkedIn.

Runs on a **$0 stack**. **Two LLM calls per run** — everything else is deterministic code.

---

## Table of Contents

1. [How It Works](#1-how-it-works)
2. [Install](#2-install)
3. [Run It](#3-run-it)
4. [Dashboard](#4-dashboard)
5. [Posting Setup](#5-posting-setup)
6. [Daily Automation](#6-daily-automation)
7. [Editing the Reel](#7-editing-the-reel)
8. [Architecture Notes](#8-architecture-notes)
9. [Known Limitations](#9-known-limitations)

---

## 1. How It Works

| Step | Stage | LLM calls | What it does |
|---|---|:---:|---|
| 1 | **News Scout** | 0 | Google News RSS + GDELT → deduped, 15 candidates |
| 2 | **Event Ranker** | 1 | One call picks *the* story of the day |
| 3 | **Script Writer** | 1 | One call returns voiceover + beats + both captions + hashtags |
| 4 | **Visual Builder** | 0 | Pexels photo → Playwright overlays → FFmpeg → mp4 + TTS |
| 5 | **Publisher** | 0 | Facebook Graph API / LinkedIn Posts API, or queue for approval |

---

## 2. Install

```bash
npm install
npm run setup          # downloads Chromium for Playwright (~150 MB, one time)
cp .env.example .env   # then paste your keys
```

> **FFmpeg is not required** — `ffmpeg-static` ships a binary with the install.
> Voiceover uses Microsoft's free Edge TTS endpoint (no key). Music is
> synthesised procedurally unless you drop a track at `server/assets/music/track.mp3`.

**Minimum keys to produce a reel:** `GROQ_API_KEY` and `PEXELS_API_KEY` — both free.
Without Pexels, the reel falls back to a branded gradient.

Confirm everything before you rely on it:

```bash
npm run check:keys      # read-only credential validation
npm run check:models    # are the configured models still served by Groq?
```

`check:keys` only ever issues `GET` requests — it never posts, uploads, or sends
a message. It reports three states:

| State | Meaning |
|---|---|
| `ok` | Verified working |
| `warn` | Cannot be verified without side effects (e.g. a `w_member_social` token with no read scope) |
| `fail` | Not working |

---

## 3. Run It

```bash
npm run run:dry                              # full chain, renders video, publishes nothing
npm run run                                  # respects the auto-post flags in config.json
node server/orchestrator.js --no-render      # news + script only (fastest smoke test)
```

Outputs land in `output/<runId>/`:

| File | What it is |
|---|---|
| `<runId>.mp4` | The 1080×1920 reel |
| `<runId>/facebook.txt` | Caption, ready to paste |
| `<runId>/linkedin.txt` | Caption, ready to paste |
| `<runId>/content.json` | Full run record (story, script, beats, timings, token usage) |

---

## 4. Dashboard

```bash
npm run dev            # API on :4000, React UI on :5173
```

Open **http://localhost:5173**. Trigger runs, preview the reel, read both
captions, copy them, and one-click approve-and-publish. The list on the left is
run history.

### 4.1 The Approval Queue

`publish.requireApproval` is `true` by default, so a finished reel is **not**
posted. It's written to `state/pendingPosts.json` and appears in the dashboard
under **Awaiting approval**, where you can preview it, approve it, or reject it.
Rejections keep the video on disk — nothing is deleted.

A run can only be queued if at least one platform is enabled, because the queue
has to record *which* platforms the reel is waiting for. With the shipped
defaults (`autoPostFacebook: false`, `autoPostLinkedIn: false`) a run reports
`no-platforms-enabled` and skips the queue entirely. To use the queue, enable
at least one:

```jsonc
"publish": {
  "requireApproval": true,      // queue instead of posting
  "autoPostFacebook": true,     // at least one of these two …
  "autoPostLinkedIn": false     // … decides what gets queued
}
```

`requireApproval` is independent of the two `autoPost*` flags: it gates *when*,
they gate *where*. Approving posts to exactly the platforms the reel was queued
for, and the queue entry is closed as `approved` or `failed` with the reason.

**Queue rules:**
- One entry per run id (re-running replaces rather than duplicates)
- 30 entries max
- An already-resolved entry cannot be approved or rejected again — the API answers `409` rather than double-posting

### 4.2 Telegram Alerts

Set `publish.notifyTelegram` to `true` (it already is) and fill in two values in `.env`:

```bash
TELEGRAM_BOT_TOKEN=...   # from @BotFather
TELEGRAM_CHAT_ID=...
```

Getting the chat id is the fiddly part, because a bot cannot message you before
you have talked to it. Open your bot in Telegram, press **Start** (or send any
message), then run:

```bash
npm run telegram:chatid
```

This reads your bot's pending updates and prints the line to paste into `.env`.
`npm run check:keys` then proves delivery with `getChat` — the check that
actually matters. (`getMe` only proves the token parses; it will happily report
a healthy bot whose chat id you got wrong.)

**Three things worth knowing:**

- **Alerts never break a run.** Every send is wrapped; a dead token, a wrong
  chat id, or Telegram being down is logged as a warning and the pipeline still
  finishes. Verified: a run completed normally while the chat id was still unset.
- **A failed video upload falls back to text**, so you still find out a reel is waiting.
- The approval message sends the **mp4 itself** with the headline as the caption,
  so you can judge the reel from your phone. It links back to the dashboard —
  approving happens there, not over Telegram.

> Set `DASHBOARD_URL` if you reach the dashboard on something other than
> `http://localhost:4000`, so the link in the message points somewhere useful.

### 4.3 Is the API Safe?

There is **no authentication**, so it is only safe while it stays on your own
machine. Three things enforce that:

- **It binds to `127.0.0.1`, not every interface.** `app.listen(port)` with no
  host argument binds `::` and would put the publish endpoint on your whole LAN.
  `HOST` in `.env` overrides it; the server prints a warning if you do.
- **CORS is restricted to local origins.** Without this, any website you happen
  to have open could `POST` to `127.0.0.1:4000` and publish to your accounts.
  Only `http://localhost:<port>` and `http://127.0.0.1:<port>` are allowed —
  note that `http://localhost.evil.com` is correctly rejected.
- **Caller-supplied ids are validated** before being joined into a path
  (`/api/captions/:id/:platform`).

The dashboard never handles a secret: `GET /api/health` reports which
credentials are *configured* as booleans, never their values, so nothing
sensitive appears in the browser's network tab. Run history, scripts, and
captions are readable by anything that can reach the port.

> **What this does not stop:** another process or script running as you on the
> same machine. CORS is a browser control, not an access control. If you need
> to expose this beyond localhost, put a real auth layer in front of it first.

---

## 5. Posting Setup

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

### 5.1 Facebook

developers.facebook.com → create app → add the **Pages** product → generate a
Page access token (long-lived). The app needs `pages_show_list`,
`pages_read_engagement`, and `pages_manage_posts`.

| Variable | Why |
|---|---|
| `FACEBOOK_APP_ID` | Opens the upload session |
| `FACEBOOK_PAGE_ID` | Which Page receives the video |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Publishes the video |
| `FACEBOOK_USER_ACCESS_TOKEN` | Optional; used for the byte upload, falls back to the Page token |

Publishing uses the current three-step **Resumable Upload** flow on Graph API
`v26.0`:

1. Open a session on `/{APP_ID}/uploads`
2. `POST` the bytes to `/upload:{SESSION_ID}` to get a file handle
3. Publish that handle to `graph-video.facebook.com/{PAGE_ID}/videos`

The older `/{PAGE_ID}/video_upload` and `upload_phase` chunking were removed, so
older examples found online will fail. The binary is uploaded directly, so no
public URL is needed.

### 5.2 LinkedIn

developers.linkedin.com → app → **"Sign In with LinkedIn"** product → request
`w_member_social`, complete the OAuth flow, then set `LINKEDIN_MEMBER_ID` (the
numeric part of `urn:li:person:<id>`) and `LINKEDIN_ACCESS_TOKEN`.

The **Posts API** replaced `ugcPosts`. Version is a **header**
(`Linkedin-Version: YYYYMM`), not a path segment. Video goes through the Videos API:

1. `initializeUpload`
2. `PUT` each 4 MB part, keeping every `ETag`
3. `finalizeUpload`
4. `POST /rest/posts` with the resulting `urn:li:video:` id

The post id comes back in the `x-restli-id` response header, not the body.

> Video posting needs extra app review on most new apps, so
> `linkedinFallbackToText` is on by default: if the video upload is rejected,
> the publisher still creates a text-only post and marks the result
> `degraded: true` rather than losing the day's post. Set it to `false` if you'd
> rather it fail loudly.

### 5.3 Telegram

Create a bot with @BotFather, message @userinfobot for your chat id.

---

Add every value as an **encrypted repository secret** for the GitHub Actions run.

---

## 6. Daily Automation

`.github/workflows/dailyReel.yml` fires at **06:17 UTC**. GitHub gives scheduled
workflows 2,000 free minutes/month; this job takes one to three.

> **Caveat:** a 15-second video cannot be posted to LinkedIn or Facebook from a
> CI runner without a publicly reachable file, and this pipeline uploads the
> binary directly instead — that works. It will stop working the moment you add
> Instagram Reels, which does require a public `file_url`; you'd add a step that
> uploads the mp4 to a public bucket first. Not a problem for this MVP.

---

## 7. Editing the Reel

Everything tunable is in `config.json` — brand colours, reel length, voice,
TTS pitch/rate, the news queries, the models, and which LLM is used for what.

The look lives in `server/templates/frame.html`. It's plain CSS and the file
renders identically in a browser, so you can iterate on the design without
restarting anything. Beat timings are computed in `server/lib/frames.js` — the
model only writes the words, never the timestamps.

---

## 8. Architecture Notes

`server/lib/llm.js` is the **only** file that imports a vendor SDK. Every agent
calls `chat()`, so moving to OpenRouter, Ollama, or any OpenAI-compatible
endpoint is a one-file change.

The model split is `llm.rankerModel` and `llm.writerModel` in `config.json`.
Both currently point at `qwen/qwen3.8-27b`, which is **deliberate — not an
oversight.** Groq's `gpt-oss-*` family are reasoning models: measured on the
real prompts, `gpt-oss-120b` needed 1,063 output tokens and 2.7s for the writer
call, where `qwen3.8-27b` used 233 tokens and 0.6s for the same valid JSON. At
`rankerMaxTokens: 200`, the reasoning models return *empty* content with
`finish_reason: length` — exactly how the pipeline first broke. If you swap in
a reasoning model, raise the token caps and expect the cost.

Model names are config, not code, and Groq retires models with no runtime
signal — `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` were removed in
August 2026. `npm run check:models` is the guard; the workflow runs it before
the pipeline so a retirement fails in seconds with a clear message instead of
mid-render.

`chat()` also degrades instead of dying: if a model rejects
`response_format: json_object` with `json_validate_failed`, it retries once
with prompt-only JSON, and a truncated response raises an error naming the
exact config key to raise.

**No database.** State is three JSON files under `state/` — a 200-entry dedupe
log, 60 run records, and the approval queue. At one reel a day, that's years of
headroom before a real database is worth the operational cost.

`npm test` runs the offline suite with Node's built-in runner (no test
dependencies). It covers the queue's persistence rules — dedupe, the 30-entry
cap, platform state, and the guards that stop a double-click reposting — plus
Telegram message formatting, including that a headline containing `<script>`
is escaped rather than injected. It never touches the network, so a failing
credential can't mask a real bug, or the other way round.

---

## 9. Known Limitations

- LinkedIn tokens expire (~60 days). Automation will need a refresh-token flow.
- LinkedIn video posting usually needs app review, which is why the publisher falls back to a text post and flags the run as `degraded`.
- `FACEBOOK_APP_ID` is required for publishing and cannot be derived from a Page access token — it has to come from the app dashboard.
- Stock photos occasionally miss for niche stories; the gradient fallback covers it.
- No performance analytics yet, so the ranker is optimising for impact, not engagement.
- Approving happens in the dashboard, not from Telegram. The message links to the dashboard rather than carrying inline Approve/Reject buttons — the approve step is a real publish to two accounts, and a single mis-tap on a phone is a hard-to-undo post.
- Nothing is scheduled locally. `npm run dev` does not re-post on a timer, and the GitHub workflow cannot run until this repo has a remote.
- Telegram delivery is proven by `getChat` but has never completed a real send, because the chat id was still unset when this was written.
