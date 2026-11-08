// Daily archive post: every certificate not posted yet, as one table, at 00:00 IST.

import {context, reddit, settings} from '@devvit/web/server'
import {formatLength} from '../shared/api.ts'
import {type Cert, md, todayIST} from './certs.ts'
import {markPosted, unposted} from './store.ts'

// a Reddit post holds 40,000 characters; keep room for the last line
const MAX_CHARS = 39_900

const HEAD =
  '| Title | Language | Category | Length | Ref | When |\n|---|---|---|---|---|---|'

/** The table in the source post's format (When = date); trimmed to fit one post. */
export function archiveText(certs: Cert[]): string {
  let text = HEAD
  let shown = 0
  for (const c of certs) {
    const row = `\n| ${[c.title, c.language, c.category, formatLength(c.secs), c.ref, c.date].map(md).join(' | ')} |`
    if (text.length + row.length > MAX_CHARS) break
    text += row
    shown++
  }
  const more = certs.length - shown
  return more ? `${text}\n\n…and ${more} more not shown` : text
}

/**
 * The app account is a mod: approve its own post (no mod queue) and mark it
 * with the MOD badge. A failure here does not undo the post.
 */
export async function asMod(post: {
  approve(): Promise<void>
  distinguish(): Promise<void>
}): Promise<void> {
  try {
    await post.approve()
    await post.distinguish()
  } catch (err) {
    console.error('approve/distinguish:', err)
  }
}

/** 00:00 IST: one post with everything not posted yet (if switched on in settings). */
export async function postArchive(): Promise<void> {
  const sub = context.subredditName
  if (!sub || !(await settings.get<boolean>('archivePost'))) return
  const certs = await unposted()
  if (!certs.length) return
  // the IST day that just ended (half a day back: safe if the run is late)
  const day = todayIST(new Date(Date.now() - 12 * 3600_000))
  const post = await reddit.submitPost({
    subredditName: sub,
    text: archiveText(certs),
    title: `🎬 CBFC certificates · ${day} (${certs.length})`,
  })
  await asMod(post)
  // only after a successful post: a failed one is tried again the next night
  await markPosted(certs.map(c => c.ref))
  console.log(`archive post: ${certs.length} certificates`)
}
