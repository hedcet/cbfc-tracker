# CBFC Tracker

Reddit (Devvit) app for following Indian CBFC film certificates. Built for [r/kerala_boxoffice](https://www.reddit.com/r/kerala_boxoffice/); works in any subreddit.

| Search                                                                                | Certificate                                                                                     | Watchlist                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Search](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/search.png) | ![Certificate](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/certificate.png) | ![Watchlist](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/watchlist.png) |

- **Search:** every stored film, newest first; tap a row for its certificate.
- **Watchlist:** follow a one-word keyword (2–20 letters/digits; 3 per user, mods unlimited) matching every title that contains it; "N new" counts since you followed. Keywords are visible to their followers until a mod makes one **public**. The last follower leaving removes a keyword; an owner leaving passes it to the earliest follower.
- **Alerts:** one modmail conversation per follower, from the subreddit (subject: the Title setting): 🔔 ON on follow, 🔕 OFF on unfollow, and new matching certificates (at most 5 per keyword and 10 per message, then "+N more").
  - More than 2 messages in an hour switches to one grouped message an hour (📦); more than 8 in a day, to one a day. A full hour (day) with at most 2 (8) updates switches back. Failed sends are retried.
  - Replies get one automatic answer a day ("🤖 Automated alerts thread · replies aren’t read, sorry.") and the thread is archived again. Mods get theirs as Mod Discussions.

## Install (moderators)

1. Install from [developers.reddit.com/apps/cbfc-tracker](https://developers.reddit.com/apps/cbfc-tracker).
2. Set the app settings (below).
3. Mod menu → **Add CBFC Tracker** creates the post.

| Setting             | Purpose                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Title               | Title of the tracker post                                                                                    |
| Source post ID      | Post (e.g. `1abc2de`) with a `\| Title \| Language \| Category \| Length \| Ref \| When \|` table. Optional. |
| Initial data (JSON) | One-time import of older certificates, imported on save; clear after.                                        |

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

Only films (≥ 1 hour, not future-dated) are kept; certificates are deduplicated by `ref`.

## Develop

Node ≥ 24 and Reddit Developer Platform access.

```bash
npm install && npx devvit login
npm test          # types, lint, unit tests, build
npm run playtest  # live on r/cbfc_tracker_dev
npm run upload    # publish a new version
```

`src/client` page code · `src/server` app server (`certs.ts` parses, `store.ts` stores certificates, `watch.ts` keywords and alerts) · `src/shared/api.ts` shared types · `public/index.html` page.
