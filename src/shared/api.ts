/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

/** Who is looking at the post. */
export type MeRsp = {username: string | null; isMod: boolean}

/** One certificate: [ref, title, language, category, secs, date, seq]. */
export type CertRow = [string, string, string, string, number, string, number]

/** Rows per search page: fits the tall post. */
export const PAGE = 6

/**
 * One page of search results, newest first.
 * total: all matches;
 * hints: two random one-word titles for the placeholders ('' when there are none).
 */
export type SearchRsp = {
  total: number
  certs: CertRow[]
  hints: [string, string]
}

/** A watchlist keyword as the viewer sees it. */
export type Keyword = {
  at: number // added, ms
  followers: number
  following: boolean
  fresh: number // matching certificates since the viewer followed
  owner: string // username, without u/
  public: boolean
  word: string // normalized: lowercase letters and digits
}

export type WatchRsp = {keywords: Keyword[]}

/** Watchlist change; the reply is the new list, or an error message. */
export type WatchReq = {
  act: 'follow' | 'unfollow' | 'public' | 'private'
  word: string
}
export type WatchActRsp = WatchRsp | ErrorRsp

/** Follow limit per user (mods: no limit). */
export const MAX_FOLLOW = 3

const STOP = new Set(
  'the of and a an in on to is it my i me we you he she his her love man life story part movie film'.split(
    ' ',
  ),
)

/** Why a keyword is refused, or '' when it is fine. */
export function keywordError(k: string): string {
  if (!/^[a-z0-9]{2,20}$/.test(k)) return '2–20 letters or digits'
  if (STOP.has(k)) return 'Too common, try another'
  return ''
}

/** Title or query → lowercase letters and digits only. */
export const norm = (t: string): string =>
  t.toLowerCase().replace(/[^0-9a-z]+/g, '')

/** Seconds → "2h 7s" (zero parts hidden), like the source post. */
export const formatLength = (secs: number): string =>
  (
    [
      [Math.floor(secs / 3600), 'h'],
      [Math.floor(secs / 60) % 60, 'm'],
      [secs % 60, 's'],
    ] as const
  )
    .filter(([n]) => n)
    .map(([n, u]) => `${n}${u}`)
    .join(' ')

/** Keyword match: the title contains the keyword (any length). */
export const kwMatch = (title: string, k: string): boolean =>
  norm(title).includes(k)

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Me: 'api/me',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnModMail: 'internal/on/modmail',
  OnPostUpdate: 'internal/on/post-update',
  OnSchedulerAlerts: 'internal/scheduler/alerts',
  OnSchedulerArchive: 'internal/scheduler/archive',
  OnSchedulerSync: 'internal/scheduler/sync',
  Search: 'api/search',
  ValidateInitialData: 'internal/settings/initial-data',
  ValidateSourcePost: 'internal/settings/source-post',
  Watch: 'api/watch',
} as const

export const EndpointMethod = {
  [Endpoint.Me]: 'GET',
  [Endpoint.Search]: 'GET',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnModMail]: 'POST',
  [Endpoint.OnPostUpdate]: 'POST',
  [Endpoint.OnSchedulerAlerts]: 'POST',
  [Endpoint.OnSchedulerArchive]: 'POST',
  [Endpoint.OnSchedulerSync]: 'POST',
  [Endpoint.ValidateSourcePost]: 'POST',
  [Endpoint.ValidateInitialData]: 'POST',
  [Endpoint.Watch]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
