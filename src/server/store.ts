import {createHash} from 'node:crypto'
import {reddit, redis, settings} from '@devvit/web/server'
import {
  type CertRow,
  kwMatch,
  type NewRsp,
  norm,
  PAGE,
  type SearchRsp,
  type SyncInfo,
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
//   sync       hash  at, added, total, error (last source post read)
//   import     str   hash of the initial data last imported
const CERTS = 'certs'
const SEQ = 'certs:seq'
const VER = 'certs:ver'
const SYNC = 'sync'
const IMPORT = 'import'
const BATCH = 500

type Stored = [string, string, string, number, string, number, 0 | 1]

/** Adds certificates not stored yet (matched by Ref). Returns how many were added. */
export async function addCerts(
  list: Cert[],
  archived: boolean,
): Promise<number> {
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

/** All certificates for the client: [ref, title, language, category, secs, date, seq]. */
export async function allCerts(): Promise<CertRow[]> {
  const all = await redis.hGetAll(CERTS)
  return Object.entries(all).map(([ref, json]) => {
    const [title, language, category, secs, date, seq] = JSON.parse(
      json,
    ) as Stored
    return [ref, title, language, category, secs, date, seq]
  })
}

// all certificates, newest first, with normalized titles; reloaded only after an add
let cache: {ver: string; rows: CertRow[]; titles: string[]} | null = null
async function sorted(): Promise<{rows: CertRow[]; titles: string[]}> {
  const ver = (await redis.get(VER)) ?? '0'
  if (cache?.ver !== ver) {
    const rows = (await allCerts()).sort(
      (a, b) => b[5].localeCompare(a[5]) || b[6] - a[6],
    )
    cache = {ver, rows, titles: rows.map(r => norm(r[1]))}
  }
  return cache
}

/** One page of certificates whose title contains q (all when q is empty). */
export async function searchCerts(q: string, page: number): Promise<SearchRsp> {
  const {rows, titles} = await sorted()
  const k = norm(q)
  const hits = k ? rows.filter((_, i) => titles[i]?.includes(k)) : rows
  const start = Math.max(0, page) * PAGE
  return {
    total: hits.length,
    certs: hits.slice(start, start + PAGE),
    exact: !!k && titles.includes(k),
    clock: rows.reduce((m, r) => Math.max(m, r[6]), 0),
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

/** Imports the initial data from settings once; the same text is not imported again. */
export async function importSetting(): Promise<void> {
  const text = ((await settings.get<string>('initialData')) ?? '').trim()
  if (!text) return
  const sum = createHash('sha1').update(text).digest('hex')
  if ((await redis.get(IMPORT)) === sum) return
  try {
    const {added, skipped} = await importJson(text)
    console.log(`initial data: ${added} added, ${skipped} skipped`)
    await redis.set(IMPORT, sum)
  } catch (err) {
    console.error(err)
  }
}

/** Reads the source post set in settings and stores new certificates. */
export async function syncSource(): Promise<SyncInfo> {
  const link = (await settings.get<string>('trackerPost')) ?? ''
  const id = postId(link)
  let added = 0
  let error = ''
  if (!id)
    error = link.trim() ? 'Source post ID is not valid' : 'Source post not set'
  else {
    try {
      const post = await reddit.getPostById(id as `t3_${string}`)
      const rows = parseTable(post.body ?? '')
      if (!rows.length) error = 'No certificate table found'
      // the post is newest first: add oldest first so the newest gets the highest seq
      else added = await addCerts(rows.reverse(), false)
    } catch (err) {
      console.error(err)
      error = 'Source post not found'
    }
  }
  const info: SyncInfo = {
    at: Date.now(),
    added,
    total: await redis.hLen(CERTS),
    error,
  }
  console.log(
    `source post: ${added} added, ${info.total} total${error ? `, ${error}` : ''}`,
  )
  await redis.hSet(SYNC, {
    at: String(info.at),
    added: String(added),
    total: String(info.total),
    error,
  })
  return info
}

export async function lastSync(): Promise<SyncInfo | null> {
  const s = await redis.hGetAll(SYNC)
  if (!s.at) return null
  return {
    at: Number(s.at),
    added: Number(s.added),
    total: Number(s.total),
    error: s.error ?? '',
  }
}

/** Imports the initial data JSON; these count as already archived. */
export async function importJson(
  text: string,
): Promise<{added: number; skipped: number}> {
  const list = parseJson(text)
  const added = await addCerts(list, true)
  return {added, skipped: list.length - added}
}
