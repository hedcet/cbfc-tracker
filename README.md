# CBFC Tracker

A Reddit tool that lets a film community follow Indian CBFC (censor board) certificates.

- **Search:** find any certified film and open its certificate details.
- **Watchlist:** follow a film name and see "N new" when a matching certificate is issued.
- **Daily archive:** once a day, a new post lists the certificates of the previous 24 hours.

Built for r/kerala_boxoffice. It works in any subreddit that has a CBFC tracker post.

> **Version 1 status:** the screens below show the finished look, but they run on **demo data** (marked "DEMO DATA"). Loading real certificates, the watchlist, and the daily archive are coming in the next versions (see [Roadmap](#roadmap)).

## Screens

| Search (opens first) | Certificate | Watchlist |
| --- | --- | --- |
| ![Search](docs/search.png) | ![Certificate](docs/certificate.png) | ![Watchlist](docs/watchlist.png) |

**Search** works for everyone, from the first letter typed. It shows "4,223 films" with an empty box, and "N matches · Watch X" while you type. Tap a row to open its certificate.

**Watchlist** rules:

- A keyword is one word of 2–20 letters or digits, like `DRISHYAM`.
- Each user can follow up to 3 keywords.
- "2 new" counts certificates issued since you followed. Tap it to see them in Search.
- Anyone can add a keyword. Mods approve it (✓) before everyone sees it.
- The person who added a keyword can delete it. A keyword disappears only when nobody follows it.

## Install (moderators)

1. Open the app page at [developers.reddit.com/apps/cbfc-tracker](https://developers.reddit.com/apps/cbfc-tracker) and click **Install**. Choose your subreddit.
2. Open the app settings: **developers.reddit.com → your subreddit → cbfc-tracker → Settings** (`https://developers.reddit.com/r/<subreddit>/apps/cbfc-tracker`).
3. Fill in the settings (below) and save.
4. In your subreddit, open the **⋯ mod menu → "Add CBFC Tracker"**. This creates the tool post, using the title from settings. Pin it if you like.

## Settings

| Setting | What it does | Default |
| --- | --- | --- |
| **Tracker title** | Title of the post created by "Add CBFC Tracker" | 🎬 CBFC Tracker |
| **Daily archive time (IST)** | Once a day at this time, a new post lists the certificates of the 24 hours before. The first post comes at the next set time after install. Choose Off to stop it. | 00:00 |
| **Source post** | Link or ID of the tracker post that `cbfc.js` keeps updating. The app reads new certificates from it and never edits it. | empty |
| **Initial data (JSON)** | Past certificates, pasted once. Loaded when you save. | empty |

### Source post format

The app reads the Markdown table in the source post. It finds each column by its header name, so the column order does not matter:

```text
| Title | Language | Category | Length | Ref | When |
```

### Initial data format

A JSON list in the same shape the app reads from the source post:

```json
[
  {"ref": "CHE/1/210/2026", "title": "ARIKOMBAN", "language": "Tamil", "category": "UA 13+", "length": "120.07", "date": "2026-11-08"}
]
```

`length` uses the CBFC portal format MM.SS (`120.07` = 2h 0m 7s).

## Develop

Requirements: Node 26.13.0 (pinned with Volta in `package.json`) and a Reddit account with Developer Platform access.

```bash
cd reddit
npm install
npx devvit login
```

| Command | What it does |
| --- | --- |
| `npm test` | Type check, lint, unit tests, build |
| `npm run playtest` | Run on the test subreddit r/cbfc_tracker_dev, reloads on save |
| `npm run upload` | Build and upload a new version |

```text
devvit.json        app config: post, menu, settings, permissions
public/index.html  the tool's page
src/client/        page code (built to public/main.js)
src/server/        app server (built to dist/server/index.js)
src/shared/api.ts  endpoints shared by client and server
docs/              screenshots
```

## Roadmap

| Version | Work | Status |
| --- | --- | --- |
| 1 | Search + Watchlist look, settings, "Add CBFC Tracker" menu | done (demo data) |
| 2 | Read the source post and initial data into storage; real Search | next |
| 3 | Real Watchlist with all the rules | |
| 4 | Daily archive post | |
| 5 | Install on r/kerala_boxoffice | |
