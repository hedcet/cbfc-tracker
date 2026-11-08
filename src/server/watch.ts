// Watchlist: keywords, followers and their modmail alerts.

import {context, reddit, redis, settings} from '@devvit/web/server'
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
export const TOOL_POST = 'post'
const KW = 'kw'
const subs = (word: string): string => `kw:${word}`
const mine = (user: string): string => `my:${user}`
const dm = (user: string): string => `dm:${user}`

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

// Markdown: keep titles literal
const md = (s: string): string => s.replace(/[\\`*_~[\]<>#|]/g, c => `\\${c}`)

async function trackerUrl(): Promise<string> {
  const id = await redis.get(TOOL_POST)
  const sub = context.subredditName
  return id && sub
    ? `https://www.reddit.com/r/${sub}/comments/${id.replace(/^t3_/, '')}/`
    : ''
}

/** One modmail conversation per user; each message is a reply in it, then archived. */
async function send(user: string, body: string): Promise<void> {
  const sub = context.subredditName
  if (!sub) return
  try {
    const old = await redis.get(dm(user))
    if (old) {
      try {
        await reddit.modMail.reply({body, conversationId: old})
        await reddit.modMail.archiveConversation(old)
        return
      } catch (err) {
        console.error(`modmail reply to ${user}:`, err) // gone: start a new one
      }
    }
    const rsp = await reddit.modMail.createConversation({
      body,
      subject: (await postTitle()).slice(0, 100),
      subredditName: sub,
      to: user,
    })
    const id = rsp.conversation.id
    if (!id) return
    await redis.set(dm(user), id)
    await reddit.modMail.archiveConversation(id)
  } catch (err) {
    console.error(`modmail to ${user}:`, err)
  }
}

export async function welcomeText(word: string): Promise<string> {
  const url = await trackerUrl()
  return [
    `**Keyword added: ${up(word)}**`,
    `🔔 Alerts **ON** for titles containing ${up(word)}.`,
    url
      ? `Not interested? [Unfollow](${url})`
      : 'Not interested? Unfollow in the tracker.',
  ].join('\n\n')
}

export const goodbyeText = (word: string): string =>
  [
    `**Keyword removed: ${up(word)}**`,
    `🔕 Alerts **OFF** for titles containing ${up(word)}.`,
  ].join('\n\n')

/** "DRISHYAM, TOXIC: 3 new certificates", then films grouped by their keywords. */
export function alertText(films: {cert: Cert; words: string[]}[]): string {
  const words = [...new Set(films.flatMap(f => f.words))].map(up)
  const n = films.length
  const groups = new Map<string, string[]>()
  for (const {cert: c, words: w} of films) {
    const label = w.map(up).join(', ')
    const line = [c.title, c.language, c.category, formatLength(c.secs)]
      .filter(Boolean)
      .map(md)
      .join(' · ')
    groups.set(label, [...(groups.get(label) ?? []), line])
  }
  const blocks = [...groups].map(([label, lines]) =>
    groups.size > 1
      ? [`**${label}**`, ...lines].join('  \n')
      : lines.join('  \n'),
  )
  return [
    `**${words.join(', ')}: ${n} new certificate${n === 1 ? '' : 's'}**`,
    ...blocks,
  ].join('\n\n')
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
