# Tech Stack

Two processes: a Node/Express API + pipeline, and a React dashboard that talks to
it over HTTP. No database, no TypeScript, no UI framework.

The two sides are separate folders with separate `package.json` files and no
imports between them. `client/` talks to `server/` only over HTTP.

```
server/   Express API + pipeline   :4000
client/   React dashboard          :5173  (proxies /api + /media to :4000)
```

## Client — `client/` (React UI on :5173)

| Concern   | Technology                                        |
| --------- | ------------------------------------------------- |
| Framework | React 18 + React DOM 18                            |
| Build/dev | Vite 6 + @vitejs/plugin-react                     |
| Styling   | Plain CSS (`client/src/styles.css`)               |
| Data      | Browser `fetch` — no axios / RTK Query             |
| State     | `useState` / `useEffect` / `useCallback` — no Redux / Zustand |
| Routing   | None (single page, component swap)                |

Vite proxies `/api` and `/media` to `http://localhost:4000` in dev, so the
dashboard needs no CORS setup and behaves the same in dev and prod.

## Server — `server/` (Express API + pipeline on :4000)

| Concern    | Technology                                             |
| ---------- | ------------------------------------------------------ |
| Runtime    | Node.js >= 20, native ESM (`"type": "module"`)         |
| Entry      | `server/index.js` (API), `server/orchestrator.js` (pipeline) |
| API        | Express 4 + `cors` (localhost-only origins)            |
| Config     | `dotenv` + `config.json`                               |
| LLM        | `groq-sdk` — only vendor SDK, isolated in `server/lib/llm.js` |
| News ingest| `rss-parser` (Google News RSS + GDELT)                |
| Video      | Playwright (frame render) + `ffmpeg-static` (encode)   |
| Voiceover  | `@andresaya/edge-tts` (Microsoft Edge TTS)             |
| Media      | Pexels API (stock photos) via plain `fetch`            |
| State      | JSON files under `state/` — no DB, no ORM              |
| Publishing | Facebook Graph API, LinkedIn Posts API, Telegram Bot API (raw `fetch`) |
| Tests      | `node --test` built-in runner — no test dependencies   |

## Tooling

- `concurrently` — runs server and client together (`npm run dev`)
- GitHub Actions (`ubuntu-latest`, Node 20) — daily reel at 06:17 UTC, server only
- `npm test` — offline suite; `test/structure.test.js` fails if either side
  imports the other or a stale folder name reappears in a path
- Local Node in use: v24.18.1 / npm 11.1.0
