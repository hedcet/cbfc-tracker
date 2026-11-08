// Watchlist: keywords, followers and their modmail alerts.

import {context, reddit, redis, settings} from '@devvit/web/server'
import type {UiResponse} from '@devvit/web/shared'
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
import type {Cert} from './certs.ts'
import {freshCounts, lastSeq} from './store.ts'

// Redis layout
//   post        str   id of the one tool post
//   kw          hash  word → JSON {at, owner, public}
//   kw:<word>   hash  username → JSON [seq, at] (follow seq: "N new" counts after it)
//   my:<user>   hash  word → '1' (keywords the user follows)
//   dm:<user>   str   modmail conversation id of the user's alerts
//   dmc:<id>    str   username of an alerts conversation (to answer replies)
//   ack:<user>  str   set for a day after an automatic answer to a reply
export const TOOL_POST = 'post'
const KW = 'kw'
const subs = (word: string): string => `kw:${word}`
const mine = (user: string): string => `my:${user}`
const dm = (user: string): string => `dm:${user}`
// conversation ids come with or without a type prefix: compare the bare id
const dmc = (id: string): string => `dmc:${id.replace(/^.*_/, '')}`
const DAY_MS = 24 * 3600_000

const DEFAULT_TITLE = '🎬 CBFC Certificates: Search & Watchlist (Unofficial)'

type Info = {at: number; owner: string; public: boolean}
type Me = {isMod: boolean; username: string}

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

// Markdown: keep titles literal
const md = (s: string): string => s.replace(/[\\`*_~[\]<>#|]/g, c => `\\${c}`)

// link to the tracker post (where unfollow is); the subreddit until it is known
async function trackerUrl(): Promise<string> {
  const id = context.postId ?? (await redis.get(TOOL_POST))
  const sub = `https://www.reddit.com/r/${context.subredditName ?? ''}/`
  return id ? `${sub}comments/${id.replace(/^t3_/, '')}/` : sub
}

/** One modmail conversation per user; each message is a reply in it, then archived. */
async function send(user: string, body: string): Promise<void> {
  const sub = context.subredditName
  if (!sub) return
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
      if (!id) return
      await redis.set(dm(user), id)
    }
    await redis.set(dmc(id), user)
    await archive(id)
  } catch (err) {
    console.error(`modmail to ${user}:`, err)
  }
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

export async function welcomeText(word: string): Promise<string> {
  const url = await trackerUrl()
  return [
    `**Keyword added: ${up(word)}**`,
    `🔔 Alerts **ON** for titles containing ${up(word)}.`,
    `Not interested? [Unfollow](${url})`,
  ].join(BR)
}

export const goodbyeText = (word: string): string =>
  [
    `**Keyword removed: ${up(word)}**`,
    `🔕 Alerts **OFF** for titles containing ${up(word)}.`,
  ].join(BR)

/** "DRISHYAM, TOXIC: 3 new certificates", then films grouped by their keywords. */
export function alertText(films: {cert: Cert; words: string[]}[]): string {
  const words = [...new Set(films.flatMap(f => f.words))].map(up)
  const n = films.length
  const groups = new Map<string, string[]>()
  for (const {cert: c, words: w} of films) {
    const label = w.map(up).join(', ')
    const line = [c.title, c.language, c.category, hm(c.secs)]
      .filter(Boolean)
      .map(md)
      .join(' · ')
    groups.set(label, [...(groups.get(label) ?? []), line])
  }
  const head = `**${words.join(', ')}: ${n} new certificate${n === 1 ? '' : 's'}**`
  // one keyword group: films right under the heading; several: a block per group
  if (groups.size === 1) return [head, ...[...groups.values()].flat()].join(BR)
  const blocks = [...groups].map(([label, lines]) =>
    [`**${label}**`, ...lines].join(BR),
  )
  return [head, ...blocks].join('\n\n')
}

/** New certificates from the source post: one alert per affected follower. */
export async function notifyNew(added: Cert[]): Promise<void> {
  if (!added.length) return
  try {
    const titles = added.map(c => norm(c.title))
    const byUser = new Map<string, Map<string, {cert: Cert; words: string[]}>>()
    for (const word of await redis.hKeys(KW)) {
      const hits = added.filter((_, i) => kwMatch(titles[i] ?? '', word))
      if (!hits.length) continue
      for (const user of await redis.hKeys(subs(word))) {
        const films = byUser.get(user) ?? new Map()
        for (const cert of hits) {
          const f = films.get(cert.ref) ?? {cert, words: []}
          f.words.push(word)
          films.set(cert.ref, f)
        }
        byUser.set(user, films)
      }
    }
    for (const [user, films] of byUser)
      await send(user, alertText([...films.values()]))
    if (byUser.size) console.log(`alerts: ${byUser.size} users`)
  } catch (err) {
    console.error(err)
  }
}

async function follow(me: Me, word: string): Promise<string> {
  const err = keywordError(word)
  if (err) return err
  const list = await redis.hKeys(mine(me.username))
  if (list.includes(word)) return `Already following ${up(word)}`
  if (!me.isMod && list.length >= MAX_FOLLOW)
    return `Limit: ${MAX_FOLLOW} keywords`
  const now = Date.now()
  if (!(await getInfo(word))) {
    const info: Info = {at: now, owner: me.username, public: me.isMod}
    await redis.hSet(KW, {[word]: JSON.stringify(info)})
  }
  await redis.hSet(subs(word), {
    [me.username]: JSON.stringify([await lastSeq(), now]),
  })
  await redis.hSet(mine(me.username), {[word]: '1'})
  await send(me.username, await welcomeText(word))
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
  } else if (info.owner === me.username) {
    await redis.hSet(KW, {[word]: JSON.stringify({...info, owner: first[0]})})
  }
  await send(me.username, goodbyeText(word))
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

async function list(me: MeRsp): Promise<Keyword[]> {
  const all = Object.entries(await redis.hGetAll(KW))
  const rows = await Promise.all(
    all.map(async ([word, json]) => {
      const info = JSON.parse(json) as Info
      const followers = await redis.hGetAll(subs(word))
      const own = me.username ? followers[me.username] : undefined
      return {
        following: !!own,
        info,
        seq: own ? (JSON.parse(own) as [number, number])[0] : 0,
        size: Object.keys(followers).length,
        word,
      }
    }),
  )
  const seen = rows.filter(r => r.info.public || me.isMod || r.following)
  const fresh = await freshCounts(seen.map(r => ({seq: r.seq, word: r.word})))
  return seen.map((r, i) => ({
    at: r.info.at,
    followers: r.size,
    following: r.following,
    fresh: r.following ? (fresh[i] ?? 0) : 0,
    owner: r.info.owner,
    public: r.info.public,
    word: r.word,
  }))
}

/** Watchlist endpoint: optional change, then the viewer's list. */
export async function watch(body: Partial<WatchReq>): Promise<WatchActRsp> {
  // remember the tracker post for alert links (also posts made before v3)
  if (context.postId && !(await redis.get(TOOL_POST)))
    await redis.set(TOOL_POST, context.postId)
  const me = await viewer()
  if (body.act) {
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

// TEMPORARY (v3 testing): every message type, with sample films, to the mod who asks
export async function preview(): Promise<UiResponse> {
  const me = await viewer()
  if (!me.username) return {showToast: 'Log in first'}
  const cert = (
    title: string,
    language: string,
    category: string,
    secs: number,
  ): Cert => ({
    category,
    date: '',
    language,
    ref: `${title}/${language}`,
    secs,
    title,
  })
  const d3 = cert('DRISHYAM 3', 'Malayalam', 'UA 13+', 9182)
  for (const body of [
    await welcomeText('drishyam'),
    alertText([{cert: d3, words: ['drishyam']}]),
    alertText([
      {cert: cert('DRISHYAM 3', 'Tamil', 'UA 13+', 9182), words: ['drishyam']},
      {cert: cert('DRISHYAM 3', 'Telugu', 'UA 13+', 9182), words: ['drishyam']},
      {
        cert: cert('TOXIC: A FAIRY TALE', 'Kannada', 'A', 9600),
        words: ['toxic'],
      },
    ]),
    alertText([
      {
        cert: cert('DRISHYAM KANTARA', 'Malayalam', 'U', 7800),
        words: ['drishyam', 'kantara'],
      },
    ]),
    goodbyeText('toxic'),
    replyText(),
  ])
    await send(me.username, body)
  return {showToast: {appearance: 'success', text: 'Sent 6 sample messages'}}
}

export const replyText = (): string =>
  [
    '🤖 **This is an automated alerts thread**',
    'Replies here aren’t read, sorry.',
  ].join(BR)

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
        body: replyText(),
        conversationId: id,
        isAuthorHidden: true,
      })
    }
  } catch (err) {
    console.error(`auto reply to ${user}:`, err)
  }
  await archive(id)
}
