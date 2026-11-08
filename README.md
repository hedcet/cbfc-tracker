# CBFC Tracker

Reddit (Devvit) app for following Indian CBFC film certificates. Built for [r/kerala_boxoffice](https://www.reddit.com/r/kerala_boxoffice/); works in any subreddit.

| Search                                                                                | Certificate                                                                                     | Watchlist                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Search](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/search.png) | ![Certificate](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/certificate.png) | ![Watchlist](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/watchlist.png) |

- **Search:** every stored film, newest first; tap a row for its certificate.
- **Watchlist:** follow up to 3 one-word keywords (2–20 letters or digits; mods unlimited) to hear about every title that contains them; "N new" shows matches since you followed. A keyword is shared with its followers, and mods can make it **public** for everyone.
- **Alerts:** one modmail conversation from the subreddit: 🔔 when you follow, 🔕 when you unfollow, and each new matching certificate.
  - Busy times stay calm: after 2 messages in an hour (or 8 in a day), updates come together in one 📦 message per hour (or day), and instant alerts return once things quiet down.
  - Replies get a short automatic note (🤖) and the thread is archived, keeping modmail tidy. (Mods receive theirs as Mod Discussions.)

## Install (moderators)

1. Install from [developers.reddit.com/apps/cbfc-tracker](https://developers.reddit.com/apps/cbfc-tracker).
2. Set the app settings (below).
3. Mod menu → **Add CBFC Tracker** creates the post.

| Setting             | Purpose                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Title               | Title of the tracker post                                                                                    |
| Source post ID      | Post (e.g. `1abc2de`) with a `\| Title \| Language \| Category \| Length \| Ref \| When \|` table. Optional. |
| Initial data (JSON) | One-time import of older certificates, imported on save; clear after.                                        |
| Daily archive post  | Every day at 00:00 IST, one post with all new certificates (off by default).                                 |

The source post is read:

- when it is edited (instantly)
- when the Source post ID is saved
- when someone opens the tracker (at most every 15 min, catches missed edits)
- hourly, as a last fallback

Initial data is a JSON list:

```json
[
  {
    "category": "UA 13+",
    "date": "2026-11-08",
    "language": "Tamil",
    "length": "2h 7s",
    "ref": "CHE/1/210/2026",
    "title": "ARIKOMBAN"
  }
]
```

Certificates are deduplicated by `ref`; future-dated ones are skipped. Search, the Watchlist and alerts show films (1 hour or longer); the daily archive post lists every item, including ads and trailers. Imported data counts as already posted.

## Develop

Node ≥ 24 and Reddit Developer Platform access.

```bash
npm install && npx devvit login
npm test          # types, lint, unit tests, build
npm run playtest  # live on r/cbfc_tracker_dev
npm run upload    # publish a new version
```

`src/client` page code · `src/server` app server (`certs.ts` parses, `store.ts` stores certificates, `watch.ts` keywords and alerts, `archive.ts` the daily post) · `src/shared/api.ts` shared types · `public/index.html` page.
