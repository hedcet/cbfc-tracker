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
 * total: all matches; exact: a title equals the query; clock: newest seq;
 * hints: two random one-word titles for the search and watchlist placeholders.
 */
export type SearchRsp = {
  total: number
  certs: CertRow[]
  exact: boolean
  clock: number
  hints: [string, string]
}

/** New certificates per keyword since its follow seq (same order as asked). */
export type NewRsp = {counts: number[]}

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

/** Keyword match on a normalized title: 2 letters = whole title; 3+ = contains. */
export const kwMatch = (title: string, k: string): boolean =>
  k.length <= 2 ? title === k : title.includes(k)

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Me: 'api/me',
  New: 'api/new',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnMenuSync: 'internal/on/menu/sync',
  OnPostUpdate: 'internal/on/post-update',
  OnSchedulerSync: 'internal/scheduler/sync',
  Search: 'api/search',
  ValidateInitialData: 'internal/settings/initial-data',
  ValidateSourcePost: 'internal/settings/source-post',
} as const

export const EndpointMethod = {
  [Endpoint.Me]: 'GET',
  [Endpoint.Search]: 'GET',
  [Endpoint.New]: 'GET',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnMenuSync]: 'POST',
  [Endpoint.OnPostUpdate]: 'POST',
  [Endpoint.OnSchedulerSync]: 'POST',
  [Endpoint.ValidateSourcePost]: 'POST',
  [Endpoint.ValidateInitialData]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
