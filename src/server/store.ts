import {createHash} from 'node:crypto'
import {reddit, redis, settings} from '@devvit/web/server'
import {
  type CertRow,
  kwMatch,
  norm,
  PAGE,
  type SearchRsp,
} from '../shared/api.ts'
import {
  type Cert,
  isFilm,
  isValid,
  parseJson,
  parseTable,
  postId,
  todayIST,
} from './certs.ts'

// Redis layout
//   certs      hash  ref → JSON [title, language, category, secs, date, seq, posted 0|1]
//              (every item; search and the watchlist use films only)
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

/** Adds certificates not stored yet (matched by Ref). Returns the ones added. */
async function addCerts(list: Cert[], archived: boolean): Promise<Cert[]> {
  const today = todayIST()
  const fresh = new Map<string, Cert>()
  for (const c of list)
    if (isValid(c, today) && !fresh.has(c.ref)) fresh.set(c.ref, c)
  const refs = [...fresh.keys()]
  const added: Cert[] = []
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
    for (const ref of todo) added.push(fresh.get(ref) as Cert)
  }
  if (added.length) await redis.incrBy(VER, 1)
  return added
}

// films only: search and "N new"
async function allCerts(): Promise<CertRow[]> {
  const all = await redis.hGetAll(CERTS)
  return Object.entries(all).flatMap(([ref, json]) => {
    const [title, language, category, secs, date, seq] = JSON.parse(
      json,
    ) as Stored
    return isFilm(secs)
      ? [[ref, title, language, category, secs, date, seq]]
      : []
  })
}

/** Items not in a daily post yet, in the source post's order (newest first). */
export async function unposted(): Promise<Cert[]> {
  return Object.entries(await redis.hGetAll(CERTS))
    .map(([ref, json]) => [ref, JSON.parse(json) as Stored] as const)
    .filter(([, s]) => !s[6])
    .sort((a, b) => b[1][5] - a[1][5])
    .map(([ref, [title, language, category, secs, date]]) => ({
      category,
      date,
      language,
      ref,
      secs,
      title,
    }))
}

/** Marks items as posted in a daily post. */
export async function markPosted(refs: string[]): Promise<void> {
  for (let i = 0; i < refs.length; i += BATCH) {
    const chunk = refs.slice(i, i + BATCH)
    const rows = await redis.hMGet(CERTS, chunk)
    const fields: Record<string, string> = {}
    chunk.forEach((ref, j) => {
      const json = rows[j]
      if (!json) return
      const s = JSON.parse(json) as Stored
      s[6] = 1
      fields[ref] = JSON.stringify(s)
    })
    if (Object.keys(fields).length) await redis.hSet(CERTS, fields)
  }
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
    exact: !!k && titles.includes(k),
    hints: [pick(), pick()],
    total: hits.length,
  }
}

/** Newest certificate seq: a follow counts what comes after it. */
export const lastSeq = async (): Promise<number> =>
  Number((await redis.get(SEQ)) ?? 0)

/** How many certificates match each word since its seq (same order). */
export async function freshCounts(
  list: {seq: number; word: string}[],
): Promise<number[]> {
  const {rows} = await sorted()
  return list.map(
    ({seq, word}) => rows.filter(r => r[6] > seq && kwMatch(r[1], word)).length,
  )
}

/** Imports initial data JSON once (same text is skipped); throws on bad JSON. */
export async function importText(raw: string): Promise<void> {
  const text = raw.trim()
  if (!text) return
  const sum = createHash('sha1').update(text).digest('hex')
  if ((await redis.get(IMPORT)) === sum) return
  const list = parseJson(text)
  const added = (await addCerts(list, true)).length // imported rows count as archived
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
/** Stores a source post table (newest first in the post); returns the new ones. */
export const addPostRows = (rows: Cert[]): Promise<Cert[]> =>
  addCerts(rows.slice().reverse(), false) // oldest first: newest gets the highest seq

/** Reads the source post set in settings and stores new certificates. */
export async function syncSource(): Promise<{
  added: Cert[]
  total: number
  error: string
}> {
  const link = (await settings.get<string>('trackerPost')) ?? ''
  const id = postId(link)
  let added: Cert[] = []
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
    `source post: ${added.length} added, ${total} total${error ? `, ${error}` : ''}`,
  )
  return {added, error, total}
}

/** Reads the source post when nobody has in the last 15 minutes (catches missed edits). */
export async function syncIfStale(): Promise<Cert[]> {
  if (await redis.get(FRESH)) return []
  await redis.set(FRESH, '1', {expiration: new Date(Date.now() + FRESH_MS)})
  return (await syncSource()).added
}
