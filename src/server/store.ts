import {reddit, redis, settings} from '@devvit/web/server'
import type {CertRow, SyncInfo} from '../shared/api.ts'
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
//   sync       hash  at, added, total, error (last source post read)
const CERTS = 'certs'
const SEQ = 'certs:seq'
const SYNC = 'sync'
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
    const last = await redis.incrBy(SEQ, todo.length)
    const fields: Record<string, string> = {}
    todo.forEach((ref, j) => {
      const c = fresh.get(ref) as Cert
      const row: Stored = [
        c.title,
        c.language,
        c.category,
        c.secs,
        c.date,
        last - todo.length + j + 1,
        archived ? 1 : 0,
      ]
      fields[ref] = JSON.stringify(row)
    })
    await redis.hSet(CERTS, fields)
    added += todo.length
  }
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

/** Reads the source post set in settings and stores new certificates. */
export async function syncSource(): Promise<SyncInfo> {
  const link = (await settings.get<string>('trackerPost')) ?? ''
  const id = postId(link)
  let added = 0
  let error = ''
  if (!id)
    error = link.trim()
      ? 'Source post link is not valid'
      : 'Source post not set in settings'
  else {
    try {
      const post = await reddit.getPostById(id as `t3_${string}`)
      const rows = parseTable(post.body ?? '')
      if (!rows.length) error = 'No certificate table in the source post'
      else added = await addCerts(rows, false)
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
