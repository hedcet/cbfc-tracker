# CBFC Tracker

A Reddit app that keeps track of film certificates issued by India's CBFC (Central Board of Film Certification). Members can search every certified film and get a message when a film they care about is certified.

Made for [r/kerala_boxoffice](https://www.reddit.com/r/kerala_boxoffice/), but any subreddit can install it.

| Search                                                                                | Certificate                                                                                     | Watchlist                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Search](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/search.png) | ![Certificate](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/certificate.png) | ![Watchlist](https://raw.githubusercontent.com/hedcet/cbfc-tracker/main/docs/watchlist.png) |

## What it does

**Search.** Lists every film the app knows about, newest first. Tap a film to see its full certificate: title, language, category (U, UA 13+, A…), running time and reference number.

**Watchlist.** Follow a word, for example `mohanlal` or `drishyam`, and you will be told about every new film whose title contains it.

- Each member can follow up to 3 words (moderators: no limit).
- A word must be one word of 2–20 letters or digits.
- "N new" shows how many matching films arrived since you started following.
- Moderators can make a word **public**, so everyone in the subreddit sees it.

**Alerts.** Messages arrive in a single modmail conversation from the subreddit:

- 🔔 when you follow a word, 🔕 when you unfollow it
- one message for each new matching certificate
- On busy days you won't be flooded: after 2 alerts in an hour (or 8 in a day), alerts are bundled into one 📦 message per hour (or per day). Instant alerts come back once it calms down.
- If you reply, you get a short automatic note (🤖) and the conversation is archived, so modmail stays clean.

**Daily archive (optional).** Every night at 00:00 IST the app posts one list of all certificates received that day.

## Setting it up (moderators)

1. Install the app from [developers.reddit.com/apps/cbfc-tracker](https://developers.reddit.com/apps/cbfc-tracker).
2. Fill in the app settings (see below).
3. Open the subreddit's mod menu and choose **Add CBFC Tracker**. This creates the tracker post.

### Settings

| Setting             | What it is for                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Title               | The title of the tracker post.                                                                   |
| Source post ID      | The Reddit post the app reads new certificates from (optional). See below.                       |
| Initial data (JSON) | A one-time import of older certificates. It is imported when you save; clear the box afterwards. |
| Daily archive post  | Turn on the nightly 00:00 IST post. Off by default.                                              |

### The source post

The app learns about new certificates by reading one Reddit post that someone keeps updated. Put that post's ID in **Source post ID**.

The ID is the part of the post's link that comes right after `/comments/`. For example, in

```
https://www.reddit.com/r/kerala_boxoffice/comments/123456/cbfc_updates/
```

the ID is `123456`.

The post must contain a table with these columns, in this order:

```
| Title | Language | Category | Length | Ref | When |
```

The app checks the post:

- right away whenever the post is edited
- right away when you save the Source post ID
- when someone opens the tracker (at most once every 15 minutes, in case an edit was missed)
- every hour, as a last safety net

### Importing older certificates

Paste a JSON list into **Initial data**, for example:

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

Good to know:

- Each certificate is stored once, identified by its `ref` number. Duplicates are ignored.
- Certificates dated in the future are skipped.
- Imported certificates count as already announced, so they don't trigger alerts or appear in the daily archive.
- Search, the Watchlist and alerts only show films (1 hour or longer). The daily archive lists everything, including ads and trailers.

## For developers

You need Node 24 or newer and access to the Reddit Developer Platform.

```bash
npm install && npx devvit login
npm test          # type check, lint, unit tests, build
npm run playtest  # run it live on r/cbfc_tracker_dev
npm run upload    # upload a new version
```

Where things live:

- `public/index.html`: the page shell
- `src/client`: the page code
- `src/server`: the app server
  - `certs.ts` reads the source post table
  - `store.ts` stores certificates
  - `watch.ts` handles watch words and alerts
  - `archive.ts` builds the daily post
- `src/shared/api.ts`: types shared by client and server
