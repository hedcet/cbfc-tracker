# CBFC Tracker

A Reddit tool that lets a film community follow Indian CBFC (censor board) certificates.

- **Search:** find any certified film and open its certificate details.
- **Watchlist:** follow a film name and see "N new" when a matching certificate is issued.
- **Archive:** each day at 00:00 IST, a new post lists every certificate not archived yet, in the same table format as the source post. Each certificate is marked once archived, so it is never posted twice.

Built for [r/kerala_boxoffice](https://www.reddit.com/r/kerala_boxoffice/). It works in any subreddit that has a CBFC tracker post.

> **Version 2 status:** Search uses real certificates from the source post and the initial data. The Watchlist still runs on **demo data** (marked "DEMO DATA"), and the archive post comes later (see [Roadmap](#roadmap)).

## Screens

| Search (opens first)                                                                  | Certificate                                                                                     | Watchlist                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Search](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/search.png) | ![Certificate](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/certificate.png) | ![Watchlist](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/watchlist.png) |

**Search** works for everyone, from the first letter typed. It shows the total, like "12,345 films", with an empty box, and "N matches · Watch X" while you type. Tap a row to open its certificate.

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

### How data comes in

- **Source post:** read every 15 minutes, and right away when `cbfc.js` edits it. Mods can also use **⋯ mod menu → "Sync CBFC data"** to read it now.
- **Initial data:** imported when you save the settings. A wrong format is refused with a short message.
- Only films are kept: 1 hour or longer, with a date that is not in the future.
- Certificates are matched by Ref, so the same certificate is never stored twice.

## Settings

| Setting                       | What it does                                                                                                                                                                                                                        | Default                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Title**                     | Title of the post created by "Add CBFC Tracker"                                                                                                                                                                                     | 🎬 CBFC Certificates: Search & Watchlist (Unofficial) |
| **Daily archive (00:00 IST)** | On: each day at 00:00 IST, a new post lists the new certificates since the last archive. Each certificate is posted once. Initial data counts as already archived.                                                                  | On                                                    |
| **Source post ID**            | ID of the live tracker post (e.g. `1abc2de`) that `cbfc.js` keeps updating. Read-only, never edited. Optional: without it the tool is search only. If set, saving shows an error when it is not a post or has no certificate table. | empty                                                 |
| **Initial data (JSON)**       | One-time import of older certificates. Certificates are matched by Ref (certificate number), so pasting the same data again never creates duplicates.                                                                               | empty                                                 |

### Source post format

The app reads the Markdown table in the source post. It finds each column by its header name, so the column order does not matter:

```text
| Title | Language | Category | Length | Ref | When |
```

### Initial data format

A JSON list in the same shape the app reads from the source post:

```json
[
  {
    "ref": "CHE/1/210/2026",
    "title": "ARIKOMBAN",
    "language": "Tamil",
    "category": "UA 13+",
    "length": "2h 7s",
    "date": "2026-11-08"
  }
]
```

`length` is written like the source post (`2h 7s`). The CBFC portal format MM.SS (`120.07`) also works.

**Making the JSON from the cbfc database:** in the `cbfc` project, run `node export.js` for everything, or `node export.js 2025-06` for one month. It writes `cbfc-<period>-snapshot-<date>.json`, like `cbfc-all-snapshot-2026-11-08.json`. All data is about 1.7 MB, so if the settings box refuses it, paste one year or one month at a time; each save adds to what is already stored.

## Develop

Requirements: Node 26.13.0 (pinned with Volta in `package.json`) and a Reddit account with Developer Platform access.

```bash
git clone https://github.com/hedcet/cbfc-tracker.git
cd cbfc-tracker
npm install
npx devvit login
```

| Command            | What it does                                                  |
| ------------------ | ------------------------------------------------------------- |
| `npm test`         | Type check, lint, unit tests, build                           |
| `npm run playtest` | Run on the test subreddit r/cbfc_tracker_dev, reloads on save |
| `npm run upload`   | Build and upload a new version                                |

```text
devvit.json        app config: post, menu, settings, permissions
public/index.html  the tool's page
src/client/        page code (built to public/main.js)
src/server/        app server (built to dist/server/index.js): certs.ts reads, store.ts stores
src/shared/api.ts  endpoints shared by client and server
docs/              screenshots
```

## Roadmap

| Version | Work                                                                        | Status           |
| ------- | --------------------------------------------------------------------------- | ---------------- |
| 1       | Search + Watchlist look, settings, "Add CBFC Tracker" menu                  | done (demo data) |
| 2       | Read the source post and initial data into storage; real Search             | done             |
| 3       | Real Watchlist with all the rules                                           | next             |
| 4       | Archive post                                                                |                  |
| 5       | Install on [r/kerala_boxoffice](https://www.reddit.com/r/kerala_boxoffice/) |                  |
