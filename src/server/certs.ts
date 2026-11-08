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
const MIN_SECS = 3600 // films only: 1 hour or more

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

/** Seconds → "2h 7s" (zero parts hidden), like the source post. */
export function formatLength(secs: number): string {
  const parts: [number, string][] = [
    [Math.floor(secs / 3600), 'h'],
    [Math.floor(secs / 60) % 60, 'm'],
    [secs % 60, 's'],
  ]
  return parts
    .filter(([n]) => n)
    .map(([n, u]) => `${n}${u}`)
    .join(' ')
}

/** Today in IST as YYYY-MM-DD. */
export const todayIST = (now = new Date()): string =>
  now.toLocaleDateString('en-CA', {timeZone: 'Asia/Kolkata'})

/** Keep films only (1 hour or more) with a sane date (not in the future). */
export const isValid = (c: Cert, today: string): boolean =>
  !!c.ref &&
  !!c.title &&
  DATE.test(c.date) &&
  c.date <= today &&
  c.secs >= MIN_SECS

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
    title: col('title'),
    language: col('language'),
    category: col('category'),
    length: col('length'),
    ref: col('ref'),
    when: col('when'),
  }
  if (Object.values(at).some(i => i < 0)) return []
  const certs: Cert[] = []
  for (const line of lines.slice(head + 2)) {
    if (!line.trim().startsWith('|')) break
    const c = cells(line)
    certs.push({
      ref: c[at.ref] ?? '',
      title: c[at.title] ?? '',
      language: c[at.language] ?? '',
      category: c[at.category] ?? '',
      secs: parseLength(c[at.length] ?? ''),
      date: (c[at.when] ?? '').split(' ')[0] ?? '', // "2026-11-06 D2" → date
    })
  }
  return certs
}

/** Reads the initial data JSON. Throws a short message when the format is wrong. */
export function parseJson(text: string): Cert[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  if (!Array.isArray(data)) throw new Error('Expected a JSON list [ … ]')
  return data.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>
    const str = (k: string): string =>
      typeof o[k] === 'string' ? (o[k] as string).trim() : ''
    if (!str('ref') || !str('title'))
      throw new Error(`Item ${i + 1}: ref, title needed`)
    return {
      ref: str('ref'),
      title: str('title'),
      language: str('language'),
      category: str('category'),
      secs: parseLength(str('length')),
      date: str('date'),
    }
  })
}

/** Post ID from a link ("…/comments/1abc2de/…") or an ID ("1abc2de", "t3_1abc2de"). */
export function postId(text: string): string {
  const s = text.trim()
  const id = /^(?:t3_)?([a-z0-9]+)$/i.exec(s)?.[1]
  return id ? `t3_${id.toLowerCase()}` : ''
}
