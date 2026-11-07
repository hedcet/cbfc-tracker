# CBFC Tracker – Reddit app

Devvit Web app for r/kerala_boxoffice: **Watchlist** (follow a keyword, see new CBFC certificates) and **Search** (find certificates). The app reads the tracker post that `cbfc.js` already maintains; it never scrapes.

- Design and rules: [`../plan.html`](../plan.html)
- Clickable prototype: [`../prototype.html`](../prototype.html)

## Requirements

- Node **26.13.0**, pinned with Volta in `package.json` (the tracker in the repo root stays on Node 20). With Volta installed, `cd reddit/app` picks it automatically.
- A Reddit account with Developer Platform access.

## One-time setup (needs the Reddit account owner)

Run in `reddit/app`:

```bash
npm install
npx devvit login          # opens a browser sign-in; use --copy-paste when working remotely
npx devvit init           # registers the app name "cbfc-tracker" on Reddit (browser flow)
```

If `cbfc-tracker` is already taken, `devvit init` asks for another name; then update `name` in `devvit.json` and `package.json`.

Create a small **test subreddit** you moderate (under 200 members), e.g. `r/cbfc_tracker_dev`, and put it in `devvit.json`:

```json
"dev": { "subreddit": "cbfc_tracker_dev" }
```

## Everyday commands

| Command            | What it does                                                            |
| ------------------ | ----------------------------------------------------------------------- |
| `npm test`         | Type check, lint, unit tests, build                                     |
| `npm run format`   | Fix formatting                                                          |
| `npm run playtest` | Install on the test subreddit and stream logs; reinstalls on every save |
| `npm run upload`   | Clean build and upload a new private version to the App Directory       |

## Layout

```
devvit.json          app config: post entry (tall), menu items, permissions
public/index.html    the post's web view
src/client/          browser code (bundled to public/main.js)
src/server/          app server (bundled to dist/server/index.js)
src/shared/api.ts    endpoints and request/response types shared by both
```

## Status

| Phase | Work                                                                              | Status |
| ----- | --------------------------------------------------------------------------------- | ------ |
| 0     | Tracker post format (Title, Language, Category, Length, Ref, When)                | done   |
| –     | App skeleton: tall post, mod menu "Create CBFC Tracker post", health check, tests | done   |
| 1     | Ingest the tracker post into Redis + one-time import                              | next   |
| 2     | Search tab + certificate sheet; post title form                                   |        |
| 3     | Watchlist                                                                         |        |
| 4     | Daily post + mod settings                                                         |        |
| 5     | Install on r/kerala_boxoffice                                                     |        |
