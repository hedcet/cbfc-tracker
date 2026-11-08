// Daily archive post: every certificate not posted yet, as one table, at 00:00 IST.

import {context, reddit, settings} from '@devvit/web/server'
import {formatLength} from '../shared/api.ts'
import {type Cert, todayIST} from './certs.ts'
import {markPosted, unposted} from './store.ts'

// a Reddit post holds 40,000 characters; keep room for the last line
const MAX_CHARS = 39_900

const HEAD =
  '| Title | Language | Category | Length | Ref | When |\n|---|---|---|---|---|---|'

// a pipe inside a cell would split the table row
const cell = (s: string): string => s.replace(/\|/g, '\\|')

/** The table in the source post's format (When = date); trimmed to fit one post. */
export function archiveText(certs: Cert[]): string {
  let text = HEAD
  let shown = 0
  for (const c of certs) {
    const row = `\n| ${[c.title, c.language, c.category, formatLength(c.secs), c.ref, c.date].map(cell).join(' | ')} |`
    if (text.length + row.length > MAX_CHARS) break
    text += row
    shown++
  }
  const more = certs.length - shown
  return more ? `${text}\n\n…and ${more} more not shown` : text
}

/** 00:00 IST: one post with everything not posted yet (if switched on in settings). */
export async function postArchive(): Promise<void> {
  const sub = context.subredditName
  if (!sub || !(await settings.get<boolean>('archivePost'))) return
  const certs = await unposted()
  if (!certs.length) return
  // the IST day that just ended (half a day back: safe if the run is late)
  const day = todayIST(new Date(Date.now() - 12 * 3600_000))
  await reddit.submitPost({
    subredditName: sub,
    text: archiveText(certs),
    title: `🎬 CBFC certificates · ${day} (${certs.length})`,
  })
  // only after a successful post: a failed one is tried again the next night
  await markPosted(certs.map(c => c.ref))
  console.log(`archive post: ${certs.length} certificates`)
}
