// Watchlist: keywords, followers and their modmail alerts.

import {context, reddit, redis, scheduler, settings} from '@devvit/web/server'
import {
  formatLength,
  type Keyword,
  keywordError,
  kwMatch,
  MAX_FOLLOW,
  type MeRsp,
  norm,
  type WatchActRsp,
  type WatchReq,
} from '../shared/api.ts'
import {type Cert, isFilm, md} from './certs.ts'
import {freshCounts, lastSeq} from './store.ts'

// Redis layout
//   post        str   id of the one tool post
//   kw          hash  word → JSON {at, n (followers), owner, public}
//   kw:<word>   hash  username → JSON [seq, at] (follow seq: "N new" counts after it)
//   my:<user>   hash  word → '1' (keywords the user follows)
//   dm:<user>   str   modmail conversation id of the user's alerts
//   dmc:<id>    str   username of an alerts conversation (to answer replies)
//   ack:<user>  str   set for a day after an automatic answer to a reply
//   told:<user> hash  word → '1' while the last ON/OFF message sent was ON
//   alerts      hash  ref → JSON Cert: new certificates waiting for the alerts job
//   alerts:job  str   set while an alerts job is scheduled
//   rate        hash  username → JSON [times] of messages sent in the last day
//   digest      hash  username → JSON {films, msgs, notes} held for a grouped message
//   mode        hash  username → JSON {at, m: 'hourly'|'daily'}: grouped mode since at
export const TOOL_POST = 'post'
const KW = 'kw'
const subs = (word: string): string => `kw:${word}`
const mine = (user: string): string => `my:${user}`
const dm = (user: string): string => `dm:${user}`
const told = (user: string): string => `told:${user}`
// conversation ids come with or without a type prefix: compare the bare id
const dmc = (id: string): string => `dmc:${id.replace(/^.*_/, '')}`
const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
const ALERTS = 'alerts'
const ALERTS_JOB = 'alerts:job'
const RATE = 'rate'
const DIGEST = 'digest'
const MODE = 'mode'

// Message limits per user (alerts and ON/OFF). More than 2 in an hour: hourly
// mode; more than 8 in a day: daily mode (one grouped message an hour / a day).
// A full hour (day) with at most 2 (8) held messages ends the grouped mode.
const PER_HOUR = 2
const PER_DAY = 8
// the hourly run comes a little early or late
const SLACK_MS = 5 * 60_000

// Lists: at most 5 lines a keyword group and 10 in a message (shared in turns);
// at most 5 keywords in a heading or label. The rest: "+N more".
const MAX_LIST = 5
const MAX_FILMS = 10

const DEFAULT_TITLE = '🎬 CBFC Certificates: Search & Watchlist (Unofficial)'

type Info = {at: number; n?: number; owner: string; public: boolean}
type Me = {isMod: boolean; username: string}
type Film = {cert: Cert; words: string[]}
type State = 'on' | 'off'
// msgs: how many messages were held back (decides when a grouped mode ends)
type Held = {films: Film[]; msgs: number; notes: Record<string, State>}
type Mode = {at: number; m: 'daily' | 'hourly'}

/** Title from settings: the tool post title and the alerts subject. */
export const postTitle = async (): Promise<string> =>
  (await settings.get<string>('postTitle'))?.trim() || DEFAULT_TITLE

/** Who is looking at the post. */
export async function viewer(): Promise<MeRsp> {
  const user = await reddit.getCurrentUser()
  if (!user) return {isMod: false, username: null}
  const perms = context.subredditName
    ? await user.getModPermissionsForSubreddit(context.subredditName)
    : []
  return {isMod: perms.length > 0, username: user.username}
}

const getInfo = async (word: string): Promise<Info | null> => {
  const json = await redis.hGet(KW, word)
  return json ? (JSON.parse(json) as Info) : null
}

const up = (w: string): string => w.toUpperCase()

// Markdown line break: lines stay right under each other
const BR = '  \n'

// "2h 33m": messages show hours and minutes only
const hm = (secs: number): string => formatLength(secs - (secs % 60))

// a line starting "1." or "-"/"+" would turn into a list
const lineStart = (s: string): string =>
  s.replace(/^(\d+)\./, '$1\\.').replace(/^([-+])/, '\\$1')

// link to the tracker post (where unfollow is); the subreddit until it is known
async function trackerUrl(): Promise<string> {
  const id = context.postId ?? (await redis.get(TOOL_POST))
  const sub = `https://www.reddit.com/r/${context.subredditName ?? ''}/`
  return id ? `${sub}comments/${id.replace(/^t3_/, '')}/` : sub
}

// keeps the mods' inbox clean; mod recipients land in Mod Discussions,
// which cannot be archived: that is fine, the message is already sent
async function archive(id: string): Promise<void> {
  try {
    await reddit.modMail.archiveConversation(id)
  } catch {
    // not archivable
  }
}

/**
 * One modmail conversation per user; each message is a reply in it, then
 * archived. False when it could not be sent (the caller keeps it for later).
 */
async function send(user: string, body: string): Promise<boolean> {
  const sub = context.subredditName
  if (!sub) return false
  try {
    let id = await redis.get(dm(user))
    if (id) {
      try {
        await reddit.modMail.reply({
          body,
          conversationId: id,
          isAuthorHidden: true, // from the subreddit, not the app account
        })
      } catch (err) {
        console.error(`modmail reply to ${user}:`, err) // gone: start a new one
        id = undefined
      }
    }
    if (!id) {
      const rsp = await reddit.modMail.createConversation({
        body,
        isAuthorHidden: true, // from the subreddit, not the app account
        subject: (await postTitle()).slice(0, 100),
        subredditName: sub,
        to: user,
      })
      id = rsp.conversation.id
      if (!id) return true // sent; nothing to remember
      await redis.set(dm(user), id)
    }
    await redis.set(dmc(id), user)
    await archive(id)
    return true
  } catch (err) {
    console.error(`modmail to ${user}:`, err)
    return false
  }
}

// what a keyword matches, as told in the ON/OFF messages
const matches = (word: string): string => `titles containing ${up(word)}`

async function welcomeText(word: string): Promise<string> {
  const url = await trackerUrl()
  return [
    `**Keyword added: ${up(word)}**`,
    `🔔 Alerts **ON** for ${matches(word)}.`,
    `Not interested? [Unfollow](${url})`,
  ].join(BR)
}

const goodbyeText = (word: string): string =>
  [
    `**Keyword removed: ${up(word)}**`,
    `🔕 Alerts **OFF** for ${matches(word)}.`,
  ].join(BR)

const REPLY = '🤖 **Automated alerts thread** · replies aren’t read, sorry.'

// "A, B, C, D, E +2 more": keywords alphabetical, at most 5
function label(words: string[]): string {
  const w = [...words].sort().map(up)
  const more = w.length - MAX_LIST
  return more > 0
    ? `${w.slice(0, MAX_LIST).join(', ')} +${more} more`
    : w.join(', ')
}

/**
 * "DRISHYAM, TOXIC: 3 new certificates", then films grouped by their keywords
 * (alphabetical): at most 5 lines a group and 10 in all, shared in turns;
 * a cut group ends "+N more".
 */
function alertText(films: Film[]): string {
  const n = films.length
  const head = `**${label([...new Set(films.flatMap(f => f.words))])}: ${n.toLocaleString('en-IN')} new certificate${n === 1 ? '' : 's'}**`
  const groups = new Map<string, {lines: string[]; words: string[]}>()
  for (const {cert: c, words} of films) {
    const line = lineStart(
      [c.title, c.language, c.category, hm(c.secs)]
        .filter(Boolean)
        .map(md)
        .join(' · '),
    )
    const key = [...words].sort().join(' ')
    const g = groups.get(key) ?? {lines: [], words}
    g.lines.push(line)
    groups.set(key, g)
  }
  const sorted = [...groups.values()]
    .map(g => ({...g, label: label(g.words)}))
    .sort((a, b) => a.label.localeCompare(b.label))
  // one line per group in turns until 10 are taken (at most 5 a group)
  const take = sorted.map(() => 0)
  for (let left = MAX_FILMS, more = true; left > 0 && more; ) {
    more = false
    sorted.forEach((g, i) => {
      const k = take[i] ?? 0
      if (left > 0 && k < Math.min(g.lines.length, MAX_LIST)) {
        take[i] = k + 1
        left--
        more = true
      }
    })
  }
  const shown = sorted.map((g, i) => {
    const k = take[i] ?? 0
    const cut = g.lines.length - k
    return {
      label: g.label,
      lines: [...g.lines.slice(0, k), ...(cut ? [`**+${cut} more**`] : [])],
    }
  })
  // one keyword group: films right under the heading; several: a block per group
  if (shown.length === 1) return [head, ...(shown[0]?.lines ?? [])].join(BR)
  const blocks = shown.map(g => [`**${g.label}**`, ...g.lines].join(BR))
  return [head, ...blocks].join('\n\n')
}

// grouped ON/OFF: "🔔 Alerts **ON**: OM, TOXIC" / "🔕 Alerts **OFF**: LEO" (+ Unfollow)
function notesText(notes: [string, State][], url: string): string {
  const of = (st: State): string =>
    label(notes.filter(([, s]) => s === st).map(([w]) => w))
  const on = of('on')
  const off = of('off')
  return [
    ...(on ? [`🔔 Alerts **ON**: ${on}`] : []),
    ...(off ? [`🔕 Alerts **OFF**: ${off}`] : []),
    ...(on ? [`Not interested? [Unfollow](${url})`] : []),
  ].join(BR)
}

// "📦 **3 updates, grouped** · max 2 messages/hour" (or 8 messages/day)
const digestHead = (n: number, m: Mode['m']): string =>
  `📦 **${n.toLocaleString('en-IN')} update${n === 1 ? '' : 's'}, grouped** · ${
    m === 'daily'
      ? `max ${PER_DAY} messages/day`
      : `max ${PER_HOUR} messages/hour`
  }`

// message times of a user, last day only
async function recentTimes(user: string): Promise<number[]> {
  const json = await redis.hGet(RATE, user)
  const since = Date.now() - DAY_MS
  return (json ? (JSON.parse(json) as number[]) : []).filter(t => t > since)
}

async function getMode(user: string): Promise<Mode | null> {
  const json = await redis.hGet(MODE, user)
  return json ? (JSON.parse(json) as Mode) : null
}

async function getHeld(user: string): Promise<Held> {
  const json = await redis.hGet(DIGEST, user)
  return json ? (JSON.parse(json) as Held) : {films: [], msgs: 0, notes: {}}
}

// instant: no grouped mode, under 2 messages this hour and 8 today
async function canSend(user: string): Promise<boolean> {
  if (await getMode(user)) return false
  const times = await recentTimes(user)
  const hour = times.filter(t => t > Date.now() - HOUR_MS).length
  return hour < PER_HOUR && times.length < PER_DAY
}

// sent: counted for the limits; false when it failed
async function deliver(user: string, body: string): Promise<boolean> {
  const times = await recentTimes(user)
  if (!(await send(user, body))) return false
  await redis.hSet(RATE, {[user]: JSON.stringify([...times, Date.now()])})
  return true
}

// held for the grouped message (films merged, last ON/OFF per keyword);
// 8 or more today: daily mode, else hourly mode
async function hold(
  user: string,
  add: Film[],
  notes: Held['notes'] = {},
): Promise<void> {
  const mode = await getMode(user)
  const daily =
    mode?.m === 'daily' || (await recentTimes(user)).length >= PER_DAY
  if (!mode || (daily && mode.m !== 'daily')) {
    const next: Mode = {at: Date.now(), m: daily ? 'daily' : 'hourly'}
    await redis.hSet(MODE, {[user]: JSON.stringify(next)})
  }
  const held = await getHeld(user)
  const films = new Map(held.films.map(f => [f.cert.ref, f]))
  for (const f of add) {
    const old = films.get(f.cert.ref)
    films.set(
      f.cert.ref,
      old ? {...old, words: [...new Set([...old.words, ...f.words])]} : f,
    )
  }
  const next: Held = {
    films: [...films.values()],
    msgs: held.msgs + 1,
    notes: {...held.notes, ...notes},
  }
  await redis.hSet(DIGEST, {[user]: JSON.stringify(next)})
}

// remembers the last ON/OFF told per keyword (no entry = OFF)
async function setTold(user: string, notes: [string, State][]): Promise<void> {
  const on = notes.filter(([, st]) => st === 'on').map(([w]) => [w, '1'])
  const off = notes.filter(([, st]) => st === 'off').map(([w]) => w)
  if (on.length) await redis.hSet(told(user), Object.fromEntries(on))
  if (off.length) await redis.hDel(told(user), off)
}

// ON/OFF of a keyword: sent now if allowed, else in the grouped message
async function note(user: string, word: string, state: State): Promise<void> {
  if (
    (await canSend(user)) &&
    (await deliver(
      user,
      state === 'on' ? await welcomeText(word) : goodbyeText(word),
    ))
  )
    return setTold(user, [[word, state]])
  await hold(user, [], {[word]: state})
}

/** New certificates: queue them; a background job sends the alerts (nobody waits). */
export async function notifyNew(all: Cert[]): Promise<void> {
  const added = all.filter(c => isFilm(c.secs)) // alerts are for films only
  if (!added.length) return
  try {
    await redis.hSet(
      ALERTS,
      Object.fromEntries(added.map(c => [c.ref, JSON.stringify(c)])),
    )
    if (await redis.get(ALERTS_JOB)) return
    await redis.set(ALERTS_JOB, '1', {
      expiration: new Date(Date.now() + 10 * 60_000), // a lost job retries later
    })
    // a moment ahead: a job time must not be in the past
    await scheduler.runJob({name: 'alerts', runAt: new Date(Date.now() + 2000)})
  } catch (err) {
    console.error(err)
  }
}

/** Alerts job (also every hour): one alert per affected follower. */
export async function sendAlerts(): Promise<void> {
  try {
    const queued = await redis.hGetAll(ALERTS)
    const refs = Object.keys(queued)
    await redis.del(ALERTS_JOB)
    if (!refs.length) return
    await redis.hDel(ALERTS, refs)
    const added = Object.values(queued).map(j => JSON.parse(j) as Cert)
    const byUser = new Map<string, Map<string, Film>>()
    for (const word of await redis.hKeys(KW)) {
      const hits = added.filter(c => kwMatch(c.title, word))
      if (!hits.length) continue
      for (const user of await redis.hKeys(subs(word))) {
        const films = byUser.get(user) ?? new Map<string, Film>()
        for (const cert of hits) {
          const f = films.get(cert.ref) ?? {cert, words: []}
          f.words.push(word)
          films.set(cert.ref, f)
        }
        byUser.set(user, films)
      }
    }
    let held = 0
    for (const [user, map] of byUser) {
      const films = [...map.values()]
      // grouped mode, over a limit, or the send failed: the grouped message
      if (!((await canSend(user)) && (await deliver(user, alertText(films))))) {
        await hold(user, films)
        held++
      }
    }
    if (byUser.size) console.log(`alerts: ${byUser.size} users, ${held} held`)
  } catch (err) {
    console.error(err)
  }
}

/**
 * Every hour: grouped messages; hourly mode each hour, daily mode once a day.
 * A full hour (day) with at most 2 (8) held messages: back to instant.
 */
export async function sendDigests(): Promise<void> {
  const now = Date.now()
  let sent = 0
  for (const [user, json] of Object.entries(await redis.hGetAll(MODE))) {
    try {
      const mode = JSON.parse(json) as Mode
      const period = mode.m === 'daily' ? DAY_MS : HOUR_MS
      // the period in which the mode started may be short: not a review
      const full = now - mode.at >= period - SLACK_MS
      if (mode.m === 'daily' && !full) continue // not a day yet
      const held = await getHeld(user)
      const last = await redis.hGetAll(told(user))
      // only states that differ from the last one told (toggled back = nothing)
      const notes = Object.entries(held.notes).filter(
        ([word, state]) => (last[word] ? 'on' : 'off') !== state,
      )
      const parts = notes.length ? [notesText(notes, await trackerUrl())] : []
      if (held.films.length) parts.push(alertText(held.films))
      if (parts.length) {
        const n = notes.length + held.films.length
        const body = [digestHead(n, mode.m), ...parts].join('\n\n')
        if (!(await deliver(user, body))) continue // kept for the next run
        await setTold(user, notes)
        sent++
      }
      await redis.hDel(DIGEST, [user])
      const limit = mode.m === 'daily' ? PER_DAY : PER_HOUR
      if (full && held.msgs <= limit) await redis.hDel(MODE, [user])
      else await redis.hSet(MODE, {[user]: JSON.stringify({...mode, at: now})})
    } catch (err) {
      console.error(`grouped message for ${user}:`, err)
    }
  }
  if (sent) console.log(`grouped messages: ${sent}`)
}

async function follow(me: Me, word: string): Promise<string> {
  const err = keywordError(word)
  if (err) return err
  const list = await redis.hKeys(mine(me.username))
  if (list.includes(word)) return `Already following ${up(word)}`
  if (!me.isMod && list.length >= MAX_FOLLOW)
    return `Limit: ${MAX_FOLLOW} keywords`
  const now = Date.now()
  const old = await getInfo(word)
  const info: Info = old
    ? {...old, n: (old.n ?? (await redis.hLen(subs(word)))) + 1}
    : {at: now, n: 1, owner: me.username, public: me.isMod}
  await redis.hSet(KW, {[word]: JSON.stringify(info)})
  await redis.hSet(subs(word), {
    [me.username]: JSON.stringify([await lastSeq(), now]),
  })
  await redis.hSet(mine(me.username), {[word]: '1'})
  await note(me.username, word, 'on')
  return ''
}

// ownership passes to the earliest follower; deleted only when nobody follows
async function unfollow(me: Me, word: string): Promise<string> {
  const info = await getInfo(word)
  if (!info || !(await redis.hGet(subs(word), me.username)))
    return `Not following ${up(word)}`
  await redis.hDel(subs(word), [me.username])
  await redis.hDel(mine(me.username), [word])
  const left = Object.entries(await redis.hGetAll(subs(word)))
    .map(
      ([user, json]) =>
        [user, (JSON.parse(json) as [number, number])[1]] as const,
    )
    .sort((a, b) => a[1] - b[1])
  const first = left[0]
  if (!first) {
    await redis.hDel(KW, [word])
    await redis.del(subs(word))
  } else {
    const owner = info.owner === me.username ? first[0] : info.owner
    await redis.hSet(KW, {
      [word]: JSON.stringify({...info, n: left.length, owner}),
    })
  }
  // the conversation records stay: replies there still get the automatic answer
  await note(me.username, word, 'off')
  return ''
}

// mods only: public = everyone sees it; that is all mods can change
async function setPublic(me: Me, word: string, on: boolean): Promise<string> {
  if (!me.isMod) return 'Mods only'
  const info = await getInfo(word)
  if (!info) return `${up(word)} not found`
  await redis.hSet(KW, {[word]: JSON.stringify({...info, public: on})})
  return ''
}

// reads: the keyword hash, plus one per keyword the viewer follows (max 3)
async function list(me: MeRsp): Promise<Keyword[]> {
  const user = me.username
  const followed = new Set(user ? await redis.hKeys(mine(user)) : [])
  const rows = Object.entries(await redis.hGetAll(KW))
    .map(([word, json]) => ({info: JSON.parse(json) as Info, word}))
    .filter(r => r.info.public || me.isMod || followed.has(r.word))
  const own = await Promise.all(
    [...followed].map(async word => {
      const json = user ? await redis.hGet(subs(word), user) : undefined
      return {seq: json ? (JSON.parse(json) as [number, number])[0] : 0, word}
    }),
  )
  const counts = await freshCounts(own)
  const fresh = new Map(own.map((o, i) => [o.word, counts[i] ?? 0]))
  return Promise.all(
    rows.map(async ({info, word}) => {
      if (info.n === undefined) {
        // keywords from before the stored count: count once, keep it
        info.n = await redis.hLen(subs(word))
        await redis.hSet(KW, {[word]: JSON.stringify(info)})
      }
      return {
        at: info.at,
        followers: info.n,
        following: followed.has(word),
        fresh: fresh.get(word) ?? 0,
        owner: info.owner,
        public: info.public,
        word,
      }
    }),
  )
}

/** Watchlist endpoint: optional change, then the viewer's list. */
export async function watch(body: Partial<WatchReq>): Promise<WatchActRsp> {
  // remember the tracker post for alert links (also posts made before v3)
  if (context.postId && !(await redis.get(TOOL_POST)))
    await redis.set(TOOL_POST, context.postId)
  const me = await viewer()
  if (body.act) {
    if (!['follow', 'private', 'public', 'unfollow'].includes(body.act))
      return {error: 'Unknown action', status: 400}
    if (!me.username) return {error: 'Log in first', status: 401}
    const who = {isMod: me.isMod, username: me.username}
    const word = norm(body.word ?? '')
    const err =
      body.act === 'follow'
        ? await follow(who, word)
        : body.act === 'unfollow'
          ? await unfollow(who, word)
          : await setPublic(who, word, body.act === 'public')
    if (err) return {error: err, status: 400}
  }
  return {keywords: await list(me)}
}

/** A user replied in their alerts conversation: answer (once a day), archive again. */
export async function onModMail(body: unknown): Promise<void> {
  const e = body as {
    conversationId?: string
    messageAuthor?: {name?: string}
    messageAuthorType?: string
  }
  if (e.messageAuthorType !== 'participant_user' || !e.conversationId) return
  const user = await redis.get(dmc(e.conversationId))
  if (!user || (e.messageAuthor?.name && e.messageAuthor.name !== user)) return
  const id = await redis.get(dm(user))
  if (!id) return
  try {
    if (!(await redis.get(`ack:${user}`))) {
      await redis.set(`ack:${user}`, '1', {
        expiration: new Date(Date.now() + DAY_MS),
      })
      await reddit.modMail.reply({
        body: REPLY,
        conversationId: id,
        isAuthorHidden: true,
      })
    }
  } catch (err) {
    console.error(`auto reply to ${user}:`, err)
  }
  await archive(id)
}
