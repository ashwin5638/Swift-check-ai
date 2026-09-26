# Swift Check AI

Marine-industry news -> one branded 15-second vertical reel per day -> Facebook + LinkedIn.
Runs on a $0 stack. **Two LLM calls per run**; everything else is deterministic code.

```
1. News Scout      0 LLM   Google News RSS + GDELT   ->  deduped, 15 candidates
2. Event Ranker    1 LLM   one call picks THE story of the day
3. Script Writer   1 LLM   one call returns voiceover + beats + both captions
4. Visual Builder  0 LLM   Pexels photo -> Playwright overlays -> FFmpeg -> mp4 + TTS
5. Publisher       0 LLM   Facebook Graph API / LinkedIn Posts API, or queue for approval
```

---

## Contents

| # | Section | What you get |
|---|---|---|
| 1 | [Quick start](#1-quick-start) | First reel in five commands |
| 2 | [Project layout](#2-project-layout) | Which folder is which side |
| 3 | [Commands](#3-commands) | Every npm script |
| 4 | [Configuration](#4-configuration) | `config.json` and `.env` |
| 5 | [The dashboard](#5-the-dashboard) | The control room UI |
| 6 | [The approval queue](#6-the-approval-queue) | How human sign-off works |
| 7 | [Telegram alerts](#7-telegram-alerts) | Phone notifications |
| 8 | [Is the API safe?](#8-is-the-api-safe) | Threat model, honestly |
| 9 | [API reference](#9-api-reference) | Every route |
| 10 | [Posting setup](#10-posting-setup) | Facebook, LinkedIn, Telegram |
| 11 | [Daily automation](#11-daily-automation) | GitHub Actions |
| 12 | [Static dashboard](#12-static-dashboard) | The Vercel path and its gap |
| 13 | [Editing the reel](#13-editing-the-reel) | Where the look and voice live |
| 14 | [Architecture notes](#14-architecture-notes) | Why it is built this way |
| 15 | [Tests](#15-tests) | What the suite covers |
| 16 | [Troubleshooting](#16-troubleshooting) | Symptoms and causes |
| 17 | [Known limitations](#17-known-limitations) | What is not solved yet |

---

## 1. Quick start

Requires Node >= 20. FFmpeg is **not** required (`ffmpeg-static` ships a binary
with the install). Voiceover uses Microsoft's free Edge TTS endpoint and needs no key.

```bash
npm install
npm run setup          # downloads Chromium for Playwright (~150 MB, one time)
cp .env.example .env   # then paste GROQ_API_KEY and PEXELS_API_KEY
npm run check:keys     # read-only credential validation
npm run run:dry        # full chain, renders video, publishes nothing
```

The reel lands in `output/<runId>/<runId>.mp4`. Open the dashboard to watch runs
and read the captions:

```bash
npm run dev            # API on :4000, UI on :5173
```

> **Rotate any key that has been pasted into a chat, a commit, or a shared
> screen.** Moving it into `.env` does not un-expose it.

## 2. Project layout

Two processes, two folders, separate `package.json` files, and **no imports
between them** - the UI talks to the API only over HTTP.

```
swift-check-ai/
|-- server/                     Express API + pipeline            :4000
|   |-- index.js                API entry (routes, static media)
|   |-- orchestrator.js         pipeline entry (CLI)
|   |-- config.js               .env + config.json loader
|   |-- agents/                 newsScout, eventRanker, scriptWriter,
|   |                           visualBuilder, publisher
|   |-- lib/                    llm, frames, audio, ffmpeg, state,
|   |                           stockImages, logger, telegram
|   |-- assets/                 logo.svg, optional music/
|   `-- templates/frame.html    the reel's visual design
|
|-- client/                     React dashboard                   :5173
|   |-- src/components/         one file per UI region
|   |-- src/lib/                format, status, useNow
|   |-- src/styles/             tokens, layout, components
|   |-- public/                 logo.svg, data/ for the static build
|   `-- vite.config.js          dev proxy: /api + /media -> :4000
|
|-- scripts/                    checkKeys, checkModels, telegramChatId,
|                               linkedinWhoami, publishDashboard
|-- test/                       node --test suites
|-- state/                      coveredEvents, runs, pendingPosts (JSON, no DB)
|                               gitignored: runtime data, not source
|-- config.json                 every tunable
|-- .env                        secrets (gitignored)
`-- output/<runId>/             mp4, captions, content.json
```

The `client/src/` and `server/lib/` trees are separate and happen to share a
folder name; neither side can import the other. `npm test` enforces that.

`test/structure.test.js` fails if either side imports the other, if a path from
the old folder layout reappears, or if the configured logo stops resolving to a
real file.

## 3. Commands

| Command | What it does |
|---|---|
| `npm run dev` | server + client together via `concurrently` |
| `npm run server` | API only, :4000 |
| `npm run client` | dashboard only, :5173 |
| `npm run build:client` | production bundle into `client/dist` |
| `npm run run` | full pipeline, honours the auto-post flags |
| `npm run run:dry` | full pipeline, renders video, publishes nothing |
| `npm run publish:dashboard` | publish run history to Vercel Blob and a static snapshot ([section 12](#12-static-dashboard)) |
| `npm test` | offline suite, 50 tests, no network |
| `npm run check:keys` | validates every credential with read-only requests |
| `npm run check:models` | confirms the configured Groq models are still served |
| `npm run telegram:chatid` | reads your bot's pending updates for the chat id |
| `npm run linkedin:whoami` | prints the member id behind your LinkedIn token |
| `npm run setup` | one-time Playwright Chromium download |

Faster smoke test that skips rendering and voiceover:

```bash
node server/orchestrator.js --no-render    # news + script only
```

## 4. Configuration

### `config.json`

Everything tunable that is not a secret.

| Key | Default | Notes |
|---|---|---|
| `brand` | Swift Check AI | name, tagline, colours, `logo` path |
| `news.googleNewsQueries` | 6 marine terms | Google News RSS search terms |
| `news.maxCandidates` | 15 | candidates kept for the ranker |
| `news.lookbackDays` | 2 | how far back to scan |
| `news.gdeltEnabled` | `false` | GDELT as a second source |
| `llm.rankerModel` | `qwen/qwen3.8-27b` | picks the story |
| `llm.writerModel` | `qwen/qwen3.8-27b` | writes the script and captions |
| `reel.durationSeconds` | 15 | 1080x1920 at 30 fps |
| `reel.voice` | `en-US-GuyNeural` | Edge TTS voice |
| `reel.voicePitch` / `voiceRate` | `-4Hz` / `+18%` | delivery tuning |
| `reel.includeMusic` | true | synthesised unless you add a track |
| `publish.requireApproval` | `true` | queue instead of posting |
| `publish.autoPostFacebook` | `true` | allow the Facebook target |
| `publish.autoPostLinkedIn` | `true` | allow the LinkedIn target |
| `publish.linkedinFallbackToText` | `true` | text post if the video is rejected |
| `publish.notifyTelegram` | `true` | send alerts |

### `.env`

| Variable | Required for | Where it comes from |
|---|---|---|
| `GROQ_API_KEY` | every run | console.groq.com |
| `PEXELS_API_KEY` | stock photos | pexels.com/api |
| `FACEBOOK_APP_ID` | publishing to FB | developers.facebook.com |
| `FACEBOOK_PAGE_ID` | publishing to FB | your Page |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | publishing to FB | long-lived Page token |
| `FACEBOOK_USER_ACCESS_TOKEN` | optional | falls back to the Page token |
| `FACEBOOK_APP_SECRET` | optional | app settings |
| `LINKEDIN_MEMBER_ID` | publishing to LI | the numeric part of `urn:li:person:<id>` |
| `LINKEDIN_ACCESS_TOKEN` | publishing to LI | OAuth with `w_member_social` |
| `TELEGRAM_BOT_TOKEN` | alerts | @BotFather |
| `TELEGRAM_CHAT_ID` | alerts | `npm run telegram:chatid` |
| `DASHBOARD_URL` | alert links | where your UI actually is |
| `PORT` | any | defaults to 4000 |
| `HOST` | any | defaults to `127.0.0.1`; changing it prints a warning |

`check:keys` reports three states per credential: `ok`, `warn` (cannot be
verified without side effects, e.g. a `w_member_social` token with no read
scope), and `fail`. It only ever issues `GET` requests - it never posts,
uploads, or sends a message.

## 5. The dashboard

`npm run dev`, then open http://localhost:5173. The UI is a four-zone control
room built for a single operator:

```
+--------------------------------------------------------------+
| status strip    pipeline . queue . auto-post . sync . clock   |
+---------------+-----------------------------+----------------+
| KPIs          | run detail                 | approval queue |
| trigger       | reel, spec, publish result | credentials    |
| run log       | waterfall, beats, script   |                |
+---------------+-----------------------------+----------------+
```

- **Status strip** - live pipeline state, queue depth, which platforms can
  auto-post, and a sync indicator that says `live`, `stale`, or `link lost`
  rather than pretending to be fine when the API is unreachable.
- **KPI strip** - six figures computed from real run history. An empty history
  renders a dash, never a fake `0%`.
- **Trigger** - `Run pipeline`, `Run dry`, and `Script only`. Button labels
  state their consequence: dry publishes nothing, script-only stops before
  rendering.
- **Run log** - history newest first, with a duration meter per row and a
  two-step delete.
- **Run detail** - reel preview, a spec table, publish results, the stage
  waterfall, on-screen beats, voiceover script, and per-platform captions with
  one-click copy.
- **Stage waterfall** - the real `steps[]` timings drawn as a cumulative gantt.
  On a typical run this shows `visualBuilder` consuming about 19 s of a 21 s run.
- **Approval queue** - pending reels with preview, approve, and reject.
- **Credentials** - which of the 11 keys are present, and what is switched off in
  `config.json`.

Deep-link any run with `?run=<id>`. Keyboard accessible throughout: a single
`<h1>`, labelled landmarks, a visible focus ring on every control, and
`prefers-reduced-motion` honoured.

Approve-and-post appears only while a reel is genuinely still queued, judged the
same way the server judges it.

## 6. The approval queue

`publish.requireApproval` is `true` by default, so a finished reel is **not**
posted. It is written to `state/pendingPosts.json` and appears in the dashboard's
approval queue as a card marked `pending review`, where you can preview it,
approve it, or reject it. Rejections keep the video on disk; nothing is deleted.

A run can only be queued if at least one platform is enabled, because the queue
has to record *which* platforms the reel is waiting for. A run with both
`autoPost*` flags false reports `no-platforms-enabled` and skips the queue.

`requireApproval` is independent of the two `autoPost*` flags: it gates *when*,
they gate *where*. Approving posts to exactly the platforms the reel was queued
for, and the entry is closed as `approved` or `failed` with the reason.

```jsonc
"publish": {
  "requireApproval": true,      // queue instead of posting
  "autoPostFacebook": true,     // at least one of these two ...
  "autoPostLinkedIn": false     // ... decides what gets queued
}
```

Flip `requireApproval` to `false` and set the per-platform flags to `true` for
fully unattended posting.

Queue rules: one entry per run id (re-running replaces rather than duplicates),
30 entries max, and an already-resolved entry cannot be approved or rejected
again - the API answers `409` rather than double-posting.

## 7. Telegram alerts

Set `publish.notifyTelegram` to `true` (it already is) and fill in two values in
`.env`:

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

It reads your bot's pending updates and prints the line to paste into `.env`.
`npm run check:keys` then proves delivery with `getChat`, which is the check that
actually matters - `getMe` only proves the token parses, and it reports a
perfectly healthy bot whose chat id you got wrong.

Three things worth knowing:

- **Alerts never break a run.** Every send is wrapped; a dead token, a wrong chat
  id, or Telegram being down is logged as a warning and the pipeline still
  finishes. Verified: a run completed normally while the chat id was still unset.
- **A failed video upload falls back to text**, so you still find out a reel is
  waiting.
- The approval message sends the **mp4 itself** with the headline as the caption,
  so you can judge the reel from your phone. It links back to the dashboard;
  approving happens there, not over Telegram.

Set `DASHBOARD_URL` if you reach the dashboard somewhere other than
`http://localhost:4000`, so the link in the message points somewhere useful.

## 8. Is the API safe?

There is **no authentication**, so it is only safe while it stays on your own
machine. Three things enforce that:

- **It binds to `127.0.0.1`, not every interface.** `app.listen(port)` with no
  host argument binds `::` and would put the publish endpoint on your whole LAN.
  `HOST` in `.env` overrides it; the server prints a warning if you do.
- **CORS is restricted to local origins.** Without this, any website you happen
  to have open could POST to `127.0.0.1:4000` and publish to your accounts. Only
  `http://localhost:<port>` and `http://127.0.0.1:<port>` are allowed - note
  that `http://localhost.evil.com` is correctly rejected.
- **Caller-supplied ids are validated** before being joined into a path
  (`/api/captions/:id/:platform`), and output paths are resolved and confirmed
  to stay inside `output/`.

The dashboard never handles a secret: `GET /api/health` reports which
credentials are *configured* as booleans, never their values, so nothing
sensitive appears in the browser's network tab. Run history, scripts, and
captions are readable by anything that can reach the port.

What this does **not** stop: another process or script running as you on the
same machine. CORS is a browser control, not an access control. If you need to
expose this beyond localhost, put a real auth layer in front of it first.

## 9. API reference

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | credential booleans, config, queue depth |
| `GET` | `/api/runs` | run summaries, newest first |
| `GET` | `/api/runs/:id` | full record: steps, llm, media, publish, script |
| `POST` | `/api/runs` | trigger a run `{ dry, skipRender }` |
| `POST` | `/api/runs/:id/publish` | approve and publish a queued run |
| `DELETE` | `/api/runs/:id` | remove a run and its files |
| `GET` | `/api/pending` | queue entries still awaiting a decision |
| `POST` | `/api/pending/:id/approve` | close as `approved` and publish |
| `POST` | `/api/pending/:id/reject` | close as `rejected`, keep the file |
| `GET` | `/api/covered` | the dedupe log of already-covered events |
| `GET` | `/api/captions/:id/:platform` | raw caption text, `facebook` or `linkedin` |
| `GET` | `/media/*` | streamed mp4 with range support so the UI can seek |

A run record carries `steps[]` (per-agent `ms` and `llmCalls`), `llm` (calls and
token counts), `media`, `beats[]`, and `publish.results[]`. A run's own `status`
freezes at `awaiting-approval` once a reel is queued, so read `publish.status`
for the outcome - the API and the UI both do this.

## 10. Posting setup

### Facebook

developers.facebook.com -> create app -> add the Pages product -> generate a
long-lived Page access token. The app needs `pages_show_list`,
`pages_read_engagement`, and `pages_manage_posts`.

Publishing uses the current three-step Resumable Upload flow on Graph API
`v26.0`: open a session on `/{APP_ID}/uploads`, `POST` the bytes to
`/upload:{SESSION_ID}` to get a file handle, then publish that handle to
`graph-video.facebook.com/{PAGE_ID}/videos`. The older `/{PAGE_ID}/video_upload`
and `upload_phase` chunking were removed, so older examples found online will
fail. The binary is uploaded directly, so no public URL is needed.

`FACEBOOK_APP_ID` is required for publishing and cannot be derived from a Page
access token - it has to come from the app dashboard.

### LinkedIn

developers.linkedin.com -> app -> "Sign In with LinkedIn" product -> request
`w_member_social`, complete the OAuth flow, then set `LINKEDIN_MEMBER_ID` (the
numeric part of `urn:li:person:<id>`) and `LINKEDIN_ACCESS_TOKEN`. Run
`npm run linkedin:whoami` to print the member id behind your token.

The Posts API replaced `ugcPosts`. Version is a **header**
(`Linkedin-Version: YYYYMM`), not a path segment. Video goes through the Videos
API: `initializeUpload` -> `PUT` each 4 MB part keeping every `ETag` ->
`finalizeUpload` -> `POST /rest/posts` with the resulting `urn:li:video:` id. The
post id comes back in the `x-restli-id` response header, not the body.

Video posting needs extra app review on most new apps, so
`linkedinFallbackToText` is on by default: if the video upload is rejected the
publisher still creates a text-only post and marks the result `degraded: true`
rather than losing the day's post. Set it to `false` if you would rather it fail
loudly.

LinkedIn tokens expire in about 60 days; see
[Known limitations](#17-known-limitations).

### Telegram

Create a bot with @BotFather, then `npm run telegram:chatid` for your chat id.

### CI

Add every value as an encrypted repository secret for the GitHub Actions run.

## 11. Daily automation

`.github/workflows/dailyReel.yml` fires at 06:17 UTC. GitHub gives scheduled
workflows 2,000 free minutes/month; this job takes one to three. The workflow
verifies credentials, verifies models, runs the pipeline, uploads the mp4 as an
artifact, and commits the dedupe log.

Scheduled runs and dispatches that leave `dry_run` on must never publish, so the
`--dry` decision is made in the shell rather than in a single GitHub expression.

One caveat worth knowing: a 15-second video can be posted to LinkedIn or
Facebook from a CI runner without a publicly reachable file, because this
pipeline uploads the binary directly. That will stop working the moment you add
Instagram Reels, which does require a public `file_url` - you would add a step
that uploads the mp4 to a public bucket first.

## 12. Static dashboard

**Status: both halves wired.** The console renders before any run exists and
reports that it is empty, rather than failing.

`npm run publish:dashboard` prepares a read-only static snapshot for a Vercel
deployment. From CI, where the pipeline has just written both, it:

1. copies the run history to `client/public/data/runs.json`, which the Vite
   build copies into `dist/` and Vercel then serves as a static asset
2. rewrites each reel's URL from the local `/media/<id>.mp4` to its Vercel Blob
   URL, so the `<video>` element can seek
3. prunes old blobs, because Hobby Blob allows 1 GB of storage and then
   hard-stops - exceeding it does not bill, it locks Blob until the month rolls

Reels need `BLOB_READ_WRITE_TOKEN`. **Vercel mints it when you create a Blob
store, and no CLI command creates one** - the project dashboard is the only
route: Storage -> Create Database -> Blob, access **Public**, then copy the
value from the store page. It has to be that long-lived token rather than the
project's OIDC vars, because the publish step runs in CI outside Vercel, where
OIDC is unavailable.

Public access is not optional: `RunDetail.jsx` plays the file in a plain
`<video>` with no auth header, and a private store's
`*.private.blob.vercel-storage.com` URLs would 403.

Put the token in two places. As the GitHub Actions secret of the same name, for
CI. And in `.env` for local runs - note that `vercel env pull` writes
`.env.local`, which **this project never reads** (`server/config.js` and
`publishDashboard.js` both load `.env` by name), and pointing it at `.env`
would overwrite the eleven pipeline credentials that live only on your machine.

**The feed and the reels are separable on purpose.** Without a token the run log
is still written, with `videoUrl: null` for reels that were never uploaded, and
only the exit code is non-zero. A store outage costs playback, not the
dashboard. `state/runs.json` is left untouched; the local `npm run dev` path
keeps serving `/media/<id>.mp4` from Express.

**The client half is a mode, not a fallback.** `client/src/lib/feed.js` reads
`VITE_READ_ONLY` at build time. Set to `1`, the console fetches
`client/public/data/runs.json` instead of `/api/*` and drops the trigger,
approve/reject, delete and credential controls - none of which can work against a
static site, and one of which would tell any visitor which of the eleven API keys
are configured. Unset, the full console talks to Express on `:4000`. The two
modes never both try to own the same view.

That flag is the entire integration, and it is build-time only: Vite inlines it,
so setting it after the build does nothing. `client/vercel.json` pins it to `1`
for the deployment, because the failure without it is loud rather than subtle -
every `/api/*` request 404s - but it is still the whole console failing. The
quieter case is the feed itself: `feed.js` reads a 404 on `data/runs.json` as
"no runs published yet" and the console says exactly that.

`GET /media/*` has no static equivalent, which is why step 2 rewrites the reel
URLs to Blob.

## 13. Editing the reel

Everything tunable that is not a secret is in `config.json` - brand colours, reel
length, voice, TTS pitch and rate, the news queries, the models, and which LLM is
used for what.

The look lives in `server/templates/frame.html`. It is plain CSS and the file
renders identically in a browser, so you can iterate on the design without
restarting anything. Beat timings are computed in `server/lib/frames.js` - the
model only writes the words, never the timestamps.

To add your own music, drop a file at `server/assets/music/track.mp3` and it is
used as-is. Otherwise an ambient pad is synthesised with FFmpeg `sine` sources,
so the repo stays free of licensed audio binaries and the reel never ships
silent.

## 14. Architecture notes

`server/lib/llm.js` is the only file that imports a vendor SDK. Every agent calls
`chat()`, so moving to OpenRouter, Ollama, or any OpenAI-compatible endpoint is a
one-file change.

The model split is `llm.rankerModel` and `llm.writerModel`. Both currently point
at `qwen/qwen3.8-27b`, which is deliberate and **not** an oversight. Groq's
`gpt-oss-*` family are reasoning models: measured on the real prompts,
`gpt-oss-120b` needed 1,063 output tokens and 2.7 s for the writer call where
`qwen3.8-27b` used 233 tokens and 0.6 s for the same valid JSON. At
`rankerMaxTokens: 200` the reasoning models return *empty* content with
`finish_reason: length`, which is exactly how the pipeline first broke. If you
swap in a reasoning model, raise the token caps and expect the cost.

Model names are config, not code, and Groq retires models with no runtime
signal - `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` were removed in
August 2026. `npm run check:models` is the guard; the workflow runs it before the
pipeline so a retirement fails in seconds with a clear message instead of
mid-render.

`chat()` also degrades instead of dying: if a model rejects
`response_format: json_object` with `json_validate_failed`, it retries once with
prompt-only JSON, and a truncated response raises an error naming the exact
config key to raise.

**No database.** State is three JSON files under `state/` - a 200-entry dedupe
log, 60 run records, and a 30-entry approval queue. At one reel a day that is
years of headroom before a real database is worth the operational cost. A corrupt
or missing file degrades to an empty list rather than crashing.

**One rule, two implementations.** The status a run should be *judged* by is
defined twice: `runDisplayStatus()` in `server/lib/state.js` and `displayStatus()`
in `client/src/lib/status.js`. They must agree, because the header and the run log
sit side by side and disagreeing about the same run is the worst thing this UI can
do. If you change one, change both, or extract a shared module.

## 15. Tests

`npm test` runs 50 tests with Node's built-in runner. No test dependencies, and
it never touches the network, so a failing credential cannot mask a real bug or
the other way round.

| Suite | Covers |
|---|---|
| `pendingQueue.test.js` | dedupe, the 30-entry cap, platform state, 409 on a second resolve, corrupt-file recovery |
| `runHistory.test.js` | delete scoping, newest-first order, and every branch of `runDisplayStatus` |
| `telegram.test.js` | HTML escaping of hostile headlines, entity encoding, message shape |
| `structure.test.js` | the server/client boundary, stale path literals, asset and logo resolution |

`runHistory.test.js` snapshots and restores the real `state/runs.json`, so
running the suite does not wipe your history.

## 16. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `date.toLocaleTimeString is not a function` | a formatter received a number instead of a Date. All formatters coerce now; if you added a new one, coerce at the boundary. |
| UI shows `link lost` in the status strip | the API on :4000 is not answering. `npm run server` and read the error. |
| Run fails with `no-platforms-enabled` | both `autoPost*` flags are false, so there is nowhere to queue a reel. Enable one. |
| A run still says `awaiting approval` after posting | its own `status` froze at queue time. Read `publish.status`; if you are reading `run.status` directly, that is the bug. |
| LinkedIn post returns `degraded: true` | the video upload was rejected (usually app review) and a text post was published instead. |
| LinkedIn upload fails on a 4 MB part | every part's `ETag` must be kept and echoed; losing one fails the finalize call. |
| `check:keys` says a token is `warn` | it cannot be verified without side effects, usually a token with no read scope. Not necessarily broken. |
| `check:models` fails in CI | Groq retired the model. Change the name in `config.json`. |
| Frame render fails after `npm run setup` | Chromium is missing or the download was interrupted. Re-run `npm run setup`. |
| `EADDRINUSE` on :4000 | another copy of the server is running. Change `PORT` or stop it. |
| Dashboard is empty but shows no error | expected until the first `publish:dashboard` runs: `feed.js` reads a 404 on `data/runs.json` as "no runs published yet". Check `client/public/data/runs.json` exists and was committed - see [section 12](#12-static-dashboard). |
| Dashboard has runs but no reel plays | the feed was written without a Blob URL. `BLOB_READ_WRITE_TOKEN` was unset, or the store is private, or the reel fell outside the 5-reel window. The publish log names which. |

## 17. Known limitations

- LinkedIn tokens expire (about 60 days). Automation will need a refresh-token flow.
- LinkedIn video posting usually needs app review, which is why the publisher
  falls back to a text post and flags the run as `degraded`.
- `FACEBOOK_APP_ID` is required for publishing and cannot be derived from a Page
  access token - it has to come from the app dashboard.
- Stock photos occasionally miss for niche stories; the gradient fallback covers it.
- No performance analytics yet, so the ranker is optimising for impact, not engagement.
- Approving happens in the dashboard, not from Telegram. The message links to the
  dashboard rather than carrying inline Approve/Reject buttons - the approve step
  is a real publish to two accounts, and a single mis-tap on a phone is a
  hard-to-undo post.
- Nothing is scheduled locally. `npm run dev` does not re-post on a timer, and
  the GitHub workflow cannot run until this repo has a remote.
- Telegram delivery is proven by `getChat` but has never completed a real send,
  because the chat id was still unset when this was written.
- The static console needs `VITE_READ_ONLY=1` in the *build*, not at runtime. It is
  pinned in `client/vercel.json`, so the supported deploy path cannot miss it, but
  a deployment made any other way still can. See [section 12](#12-static-dashboard).
- The status-derivation rule is implemented on both sides of the boundary and has
  to be kept in sync by hand.
