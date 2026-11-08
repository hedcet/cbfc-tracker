// Reading certificates from the source post (Markdown table) and from the
// initial data (JSON). Pure functions: no Reddit or Redis calls here.

export type Cert = {
  ref: string
  title: string
  language: string
  category: string
  secs: number // certified length in seconds
  date: string // YYYY-MM-DD, IST
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
// films: 1 hour or more (search, watchlist, alerts); the daily post has every item
const FILM_SECS = 3600
export const isFilm = (secs: number): boolean => secs >= FILM_SECS

/** "2h 7s", "2h 33m 2s" (source post) or "120.07" (CBFC portal MM.SS) → seconds. */
export function parseLength(text: string): number {
  const s = text.trim()
  const mmss = /^(\d+)\.(\d{1,2})$/.exec(s)
  if (mmss) return 60 * Number(mmss[1]) + Number(mmss[2])
  let secs = 0
  let found = false
  for (const [, n, unit] of s.matchAll(/(\d+)\s*([hms])/g)) {
    found = true
    secs += Number(n) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1)
  }
  return found ? secs : 0
}

/** Today in IST as YYYY-MM-DD. */
export const todayIST = (now = new Date()): string =>
  now.toLocaleDateString('en-CA', {timeZone: 'Asia/Kolkata'})

/** Keep items with a ref, a title and a sane date (not in the future). */
export const isValid = (c: Cert, today: string): boolean =>
  !!c.ref && !!c.title && DATE.test(c.date) && c.date <= today

// split a table row on unescaped pipes, then unescape \[ \] \|
function cells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i]
      continue
    }
    if (ch === '|') {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur.trim())
  // drop the empty cells before the first and after the last pipe
  if (line.trim().startsWith('|')) out.shift()
  if (line.trim().endsWith('|') && !line.trim().endsWith('\\|')) out.pop()
  return out
}

/** Reads the source post table. Columns are found by header name, in any order. */
export function parseTable(markdown: string): Cert[] {
  const lines = markdown.split(/\r?\n/)
  const head = lines.findIndex(l => /\|\s*title\s*\|/i.test(l))
  if (head < 0) return []
  const names = cells(lines[head] ?? '').map(n => n.toLowerCase())
  const col = (name: string): number => names.indexOf(name)
  const at = {
    category: col('category'),
    language: col('language'),
    length: col('length'),
    ref: col('ref'),
    title: col('title'),
    when: col('when'),
  }
  if (Object.values(at).some(i => i < 0)) return []
  const certs: Cert[] = []
  for (const line of lines.slice(head + 2)) {
    if (!line.trim().startsWith('|')) break
    const c = cells(line)
    certs.push({
      category: c[at.category] ?? '',
      date: (c[at.when] ?? '').split(' ')[0] ?? '', // "2026-11-06 D2" → date
      language: c[at.language] ?? '',
      ref: c[at.ref] ?? '',
      secs: parseLength(c[at.length] ?? ''),
      title: c[at.title] ?? '',
    })
  }
  return certs
}

/** Reads the initial data JSON. Throws a short message when the format is wrong. */
export function parseJson(text: string): Cert[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    // the parser's own message, like "Unexpected token o in JSON at position 1"
    throw new Error(err instanceof Error ? err.message : String(err))
  }
  if (!Array.isArray(data)) throw new Error('Expected a JSON list [ … ]')
  return data.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>
    const str = (k: string): string =>
      typeof o[k] === 'string' ? (o[k] as string).trim() : ''
    for (const k of ['ref', 'title'])
      if (!str(k)) throw new Error(`Item ${i + 1}: "${k}" missing`)
    return {
      category: str('category'),
      date: str('date'),
      language: str('language'),
      ref: str('ref'),
      secs: parseLength(str('length')),
      title: str('title'),
    }
  })
}

/** Post ID ("1abc2de" or "t3_1abc2de"); links are refused. */
export function postId(text: string): string {
  const s = text.trim()
  const id = /^(?:t3_)?([a-z0-9]+)$/i.exec(s)?.[1]
  return id ? `t3_${id.toLowerCase()}` : ''
}
