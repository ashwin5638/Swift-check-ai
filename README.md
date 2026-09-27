# Swift Check AI

Marine industry news → one branded 20-second vertical reel per day → Facebook + LinkedIn.

- Runs on a free stack.
- Only 2 LLM calls per run. Everything else is plain code.
- One reel a day, fully automatic.

---

## 1. How It Works

1. **News Scout** — pulls Google News RSS (+ optional GDELT) → dedupes → 15 candidates.
2. **Event Ranker** — 1 LLM call picks the story of the day.
3. **Script Writer** — 1 LLM call writes the voiceover, beats and both captions.
4. **Visual Builder** — Pexels photo → Playwright overlays → FFmpeg → mp4 + voiceover.
5. **Publisher** — posts to Facebook/LinkedIn, or waits for your approval.

---

## 2. Quick Start

- Requires Node 20+.
- FFmpeg is not needed — `ffmpeg-static` installs its own binary.
- Voiceover uses free Edge TTS — no API key.

```bash
npm install
npm run setup          # one-time Chromium download for Playwright
cp .env.example .env   # add GROQ_API_KEY and PEXELS_API_KEY
npm run check:keys     # validate credentials (read-only)
npm run run:dry        # full run, renders video, publishes nothing
```

- Output: `output/<runId>/<runId>.mp4`
- Dashboard: `npm run dev` → http://localhost:5173

> Rotate any key that was ever pasted into a chat, commit or screen.

---

## 3. Project Layout

```
server/       Express API + pipeline        :4000
  agents/     newsScout, eventRanker, scriptWriter, visualBuilder, publisher
  lib/        llm, frames, audio, ffmpeg, state, stockImages, telegram
  assets/     logo.svg, optional music/
  templates/  frame.html  (the reel's design)

client/       React dashboard                :5173
  src/        components, lib, styles
  public/     logo.svg, data/

api/          Vercel serverless routes (deployed control plane)
scripts/      checkKeys, checkModels, publishDashboard, helpers
state/        runs, coveredEvents, pendingPosts (JSON)
config.json   all tunables
.env          secrets
output/       generated reels
```

- Server and client never import each other — they talk over HTTP only.

---

## 4. Commands

| Command | What it does |
|---|---|
| `npm run dev` | server + dashboard together |
| `npm run server` | API only, :4000 |
| `npm run client` | dashboard only, :5173 |
| `npm run build:client` | production build into `client/dist` |
| `npm run run` | full pipeline, respects the auto-post flags |
| `npm run run:dry` | full pipeline, publishes nothing |
| `npm run check:keys` | validate every credential |
| `npm run check:models` | confirm configured models are still served |
| `npm run telegram:chatid` | print your Telegram chat id |
| `npm run linkedin:whoami` | print the member id behind your token |
| `npm run publish:dashboard` | push run history to Vercel Blob |
| `npm run publish:reel` | post a queued reel (used by CI) |
| `npm run setup` | one-time Playwright Chromium install |

- Quick check without video: `node server/orchestrator.js --no-render`

---

## 5. Configuration

### `config.json` — everything that is not a secret

| Key | Default | What it controls |
|---|---|---|
| `brand.*` | Swift Check AI | name, tagline, colours, logo |
| `news.googleNewsQueries` | 6 marine terms | search terms |
| `news.maxCandidates` | 15 | candidates kept for the ranker |
| `news.lookbackDays` | 2 | how far back to scan |
| `news.gdeltEnabled` | `false` | use GDELT as a second source |
| `llm.rankerModel` | `qwen/qwen3.8-27b` | picks the story |
| `llm.writerModel` | `qwen/qwen3.8-27b` | writes script + captions |
| `reel.durationSeconds` | 20 | target length (1080×1920, 30 fps) |
| `reel.maxDurationSeconds` | 30 | ceiling if narration runs long |
| `reel.voice` | `en-US-GuyNeural` | TTS voice |
| `reel.voicePitch` / `voiceRate` | `-4Hz` / `+18%` | delivery tuning |
| `reel.includeMusic` | `true` | background music |
| `publish.requireApproval` | `true` | queue instead of posting |
| `publish.autoPostFacebook` | `true` | allow Facebook |
| `publish.autoPostLinkedIn` | `true` | allow LinkedIn |
| `publish.linkedinFallbackToText` | `true` | text post if video is rejected |
| `publish.notifyTelegram` | `true` | send alerts |

### `.env` — secrets

| Variable | Needed for | Source |
|---|---|---|
| `GROQ_API_KEY` | every run | console.groq.com |
| `PEXELS_API_KEY` | stock photos | pexels.com/api |
| `FACEBOOK_APP_ID` | Facebook posting | app dashboard |
| `FACEBOOK_PAGE_ID` | Facebook posting | your Page |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Facebook posting | long-lived Page token |
| `FACEBOOK_USER_ACCESS_TOKEN` | optional | fallback for the Page token |
| `LINKEDIN_MEMBER_ID` | LinkedIn posting | number in `urn:li:person:<id>` |
| `LINKEDIN_ACCESS_TOKEN` | LinkedIn posting | OAuth with `w_member_social` |
| `TELEGRAM_BOT_TOKEN` | alerts | @BotFather |
| `TELEGRAM_CHAT_ID` | alerts | `npm run telegram:chatid` |
| `DASHBOARD_URL` | alert links | where your UI lives |
| `PORT` / `HOST` | optional | default 4000 / 127.0.0.1 |

- `check:keys` reports each key as `ok`, `warn` or `fail` using only read requests.

---

## 6. Dashboard

- Four zones: status strip, KPIs + run log, run detail, approval queue + credentials.
- Status strip shows live pipeline state, queue depth, auto-post targets and sync health.
- KPI strip reads real run history — empty history shows a dash, never a fake `0%`.
- Triggers: **Run pipeline**, **Run dry**, **Script only**.
- Run detail: reel preview, spec table, stage waterfall, beats, script, captions with copy button.
- Deep-link any run with `?run=<id>`.

---

## 7. Approval Queue

- `publish.requireApproval: true` means a finished reel is **not** posted.
- It is saved to `state/pendingPosts.json` and shown in the dashboard queue.
- You can preview, approve or reject. Rejecting keeps the video file.
- Approving posts to exactly the platforms the reel was queued for.
- Already-resolved entries return `409` instead of double-posting.
- Set `requireApproval: false` (plus both `autoPost*` flags `true`) for fully unattended posting.

---

## 8. Telegram Alerts

- Already enabled. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `.env`.
- Get the chat id: open your bot in Telegram → press **Start** → run `npm run telegram:chatid`.
- Alerts never break a run — a bad token is logged as a warning only.
- If the video upload fails, it sends a text alert instead.
- The approval message includes the mp4 so you can judge the reel from your phone.

---

## 9. API Reference

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | credential flags, config, queue depth |
| `GET` | `/api/runs` | run summaries, newest first |
| `GET` | `/api/runs/:id` | full record: steps, llm, media, publish, script |
| `POST` | `/api/runs` | trigger a run `{ dry, skipRender }` |
| `POST` | `/api/runs/:id/publish` | approve and publish a queued run |
| `DELETE` | `/api/runs/:id` | remove a run and its files |
| `GET` | `/api/pending` | queue entries awaiting a decision |
| `POST` | `/api/pending/:id/approve` | approve and publish |
| `POST` | `/api/pending/:id/reject` | reject, keep the file |
| `GET` | `/api/covered` | dedupe log of covered events |
| `GET` | `/api/captions/:id/:platform` | raw caption text |
| `GET` | `/media/*` | streamed mp4 (supports seeking) |

- Read `publish.status` for the outcome, not `run.status`.

---

## 10. Platform Setup

- **Facebook** — create an app, add the Pages product, generate a long-lived Page token. Needs `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`. Uploads use the Resumable Upload flow; the binary goes up directly, so no public URL is needed.
- **LinkedIn** — create an app with "Sign In with LinkedIn", request `w_member_social`, then set the member id and token. `npm run linkedin:whoami` prints the id. Video posting needs app review, so a text-only fallback is enabled by default.
- **Telegram** — @BotFather for the token, `npm run telegram:chatid` for the chat id.

---

## 11. Daily Automation

- `.github/workflows/dailyReel.yml` runs at 06:17 UTC.
- It checks credentials, checks models, runs the pipeline, uploads the mp4 artifact and commits the dedupe log.
- Every value must be added as an encrypted repository secret.
- Dry runs never publish — the decision is enforced in the shell.

---

## 12. Deployment (Vercel)

- `client/` builds as a static site; `api/` becomes serverless functions on the same origin.
- Set the Vercel **Root Directory to the repository root** (not `client/`) or no functions get built.
- `client` is an npm workspace, so there is a single lockfile and a single `npm ci`.
- `scripts/vercelPreflight.js` runs first and fails the build on a wrong Root Directory, a missing lockfile, or more than 12 functions.

| Where | What |
|---|---|
| `api/` | Vercel Functions — control plane only |
| `client/` | static Vite build |
| `server/` | never on Vercel — GitHub Actions only (needs Chromium, ffmpeg, writable disk) |
| `state/` | Vercel Blob, not a function filesystem |

**Environment variables**

- `BLOB_READ_WRITE_TOKEN` — Vercel **and** CI. Create it in the dashboard: Storage → Blob (access: **Public**). No CLI command can mint one.
- `GITHUB_TOKEN`, `GITHUB_REPO` — Vercel only. Lets the trigger and approve buttons dispatch a workflow.

- Static fallback: set `VITE_READ_ONLY=1` to read `client/public/data/runs.json` instead of the API (read-only UI).
- `npm run publish:dashboard` copies run history into the client, rewrites reel URLs to Blob, and prunes old blobs (Hobby caps storage at 1 GB).
- **No authentication** on the API or deployed routes. Add protection before exposing it publicly.

---

## 13. Customising the Reel

- Colours, length, voice, pitch, queries, models → all in `config.json`.
- The look lives in `server/templates/frame.html` — plain CSS, renders in a browser for quick iteration.
- Beat timings are computed in `server/lib/frames.js`; the model only writes the words.
- Add your own music at `server/assets/music/track.mp3`. Without one, an ambient pad is synthesised with FFmpeg.

---

## 14. Architecture Notes

- `server/lib/llm.js` is the only file importing a vendor SDK — switching providers is a one-file change.
- Ranker and writer use the same non-reasoning model on purpose; reasoning models return empty content under the token caps.
- `npm run check:models` guards against providers retiring models.
- **No database** — three JSON files under `state/`: dedupe log, run records, approval queue. Corrupt files degrade to an empty list.
- Run status is derived in both `server/lib/state.js` and `client/src/lib/status.js`. They must stay in sync.
- Routes exist in both `server/index.js` and `api/_app.js`. Add new routes to both.
