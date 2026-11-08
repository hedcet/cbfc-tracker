import {createHash} from 'node:crypto'
import {reddit, redis, settings} from '@devvit/web/server'
import {
  type CertRow,
  kwMatch,
  type NewRsp,
  norm,
  PAGE,
  type SearchRsp,
} from '../shared/api.ts'
import {
  type Cert,
  isValid,
  parseJson,
  parseTable,
  postId,
  todayIST,
} from './certs.ts'

// Redis layout
//   certs      hash  ref → JSON [title, language, category, secs, date, seq, archived 0|1]
//   certs:seq  int   order in which certificates were first seen
//   certs:ver  int   bumped on every add; the search cache reloads when it changes
//   import     str   hash of the initial data last imported
//   fresh      str   set while the source post was read in the last 15 min
const CERTS = 'certs'
const SEQ = 'certs:seq'
const VER = 'certs:ver'
const IMPORT = 'import'
const FRESH = 'fresh'
const FRESH_MS = 15 * 60_000
const BATCH = 500

type Stored = [string, string, string, number, string, number, 0 | 1]

/** Adds certificates not stored yet (matched by Ref). Returns how many were added. */
async function addCerts(list: Cert[], archived: boolean): Promise<number> {
  const today = todayIST()
  const fresh = new Map<string, Cert>()
  for (const c of list)
    if (isValid(c, today) && !fresh.has(c.ref)) fresh.set(c.ref, c)
  const refs = [...fresh.keys()]
  let added = 0
  for (let i = 0; i < refs.length; i += BATCH) {
    const chunk = refs.slice(i, i + BATCH)
    const known = await redis.hMGet(CERTS, chunk)
    const todo = chunk.filter((_, j) => known[j] == null)
    if (!todo.length) continue
    // initial data is oldest first; number it in date order so "newest" sorts right
    todo.sort((a, b) =>
      (fresh.get(a)?.date ?? '').localeCompare(fresh.get(b)?.date ?? ''),
    )
    // imported (archived) rows are old: seq 0, so they never count as new for a keyword
    const last = archived ? 0 : await redis.incrBy(SEQ, todo.length)
    const fields: Record<string, string> = {}
    todo.forEach((ref, j) => {
      const c = fresh.get(ref) as Cert
      const row: Stored = [
        c.title,
        c.language,
        c.category,
        c.secs,
        c.date,
        archived ? 0 : last - todo.length + j + 1,
        archived ? 1 : 0,
      ]
      fields[ref] = JSON.stringify(row)
    })
    await redis.hSet(CERTS, fields)
    added += todo.length
  }
  if (added) await redis.incrBy(VER, 1)
  return added
}

async function allCerts(): Promise<CertRow[]> {
  const all = await redis.hGetAll(CERTS)
  return Object.entries(all).map(([ref, json]) => {
    const [title, language, category, secs, date, seq] = JSON.parse(
      json,
    ) as Stored
    return [ref, title, language, category, secs, date, seq]
  })
}

// all certificates, newest first, with normalized titles; reloaded only after an add
// names: one-word titles, used as placeholder examples (also valid keywords)
type Cache = {ver: string; rows: CertRow[]; titles: string[]; names: string[]}
let cache: Cache | null = null

async function sorted(): Promise<Cache> {
  const ver = (await redis.get(VER)) ?? '0'
  if (cache?.ver !== ver) {
    const rows = (await allCerts()).sort(
      (a, b) => b[5].localeCompare(a[5]) || b[6] - a[6],
    )
    cache = {
      names: rows.map(r => r[1]).filter(t => /^[A-Z0-9]{5,14}$/.test(t)),
      rows,
      titles: rows.map(r => norm(r[1])),
      ver,
    }
  }
  return cache
}

/** One page of certificates whose title contains q (all when q is empty). */
export async function searchCerts(q: string, page: number): Promise<SearchRsp> {
  const {rows, titles, names} = await sorted()
  const k = norm(q)
  const pick = (): string =>
    names[Math.floor(Math.random() * names.length)] ?? 'DRISHYAM'
  const hits = k ? rows.filter((_, i) => titles[i]?.includes(k)) : rows
  const start = Math.max(0, page) * PAGE
  return {
    certs: hits.slice(start, start + PAGE),
    clock: rows.reduce((m, r) => Math.max(m, r[6]), 0),
    exact: !!k && titles.includes(k),
    hints: [pick(), pick()],
    total: hits.length,
  }
}

/** For each "keyword:seq", how many certificates matched after that seq. */
export async function newCounts(list: string[]): Promise<NewRsp> {
  const {rows, titles} = await sorted()
  return {
    counts: list.map(item => {
      const [k = '', since = '0'] = item.split(':')
      const word = norm(k)
      if (!word) return 0
      return rows.filter(
        (r, i) => r[6] > Number(since) && kwMatch(titles[i] ?? '', word),
      ).length
    }),
  }
}

/** Imports initial data JSON once (same text is skipped); throws on bad JSON. */
export async function importText(raw: string): Promise<void> {
  const text = raw.trim()
  if (!text) return
  const sum = createHash('sha1').update(text).digest('hex')
  if ((await redis.get(IMPORT)) === sum) return
  const list = parseJson(text)
  const added = await addCerts(list, true) // imported rows count as archived
  console.log(`initial data: ${added} added, ${list.length - added} skipped`)
  await redis.set(IMPORT, sum)
}

/** Imports the initial data from settings once; the same text is not imported again. */
export async function importSetting(): Promise<void> {
  try {
    await importText((await settings.get<string>('initialData')) ?? '')
  } catch (err) {
    console.error(err)
  }
}

/** Stores the certificates of a source post table (newest first in the post). */
export const addPostRows = (rows: Cert[]): Promise<number> =>
  addCerts(rows.slice().reverse(), false) // oldest first: newest gets the highest seq

/** Reads the source post set in settings and stores new certificates. */
export async function syncSource(): Promise<{
  added: number
  total: number
  error: string
}> {
  const link = (await settings.get<string>('trackerPost')) ?? ''
  const id = postId(link)
  let added = 0
  let error = ''
  if (!id) {
    // optional: no source post is fine (search only), not an error
    if (link.trim()) error = 'Source post ID is not valid'
  } else {
    try {
      const post = await reddit.getPostById(id as `t3_${string}`)
      const rows = parseTable(post.body ?? '')
      if (!rows.length) error = 'No certificate table found'
      else added = await addPostRows(rows)
    } catch (err) {
      console.error(err)
      error = 'Source post not found'
    }
  }
  const total = await redis.hLen(CERTS)
  console.log(
    `source post: ${added} added, ${total} total${error ? `, ${error}` : ''}`,
  )
  return {added, error, total}
}

/** Reads the source post when nobody has in the last 15 minutes (catches missed edits). */
export async function syncIfStale(): Promise<void> {
  if (await redis.get(FRESH)) return
  await redis.set(FRESH, '1', {expiration: new Date(Date.now() + FRESH_MS)})
  await syncSource()
}
