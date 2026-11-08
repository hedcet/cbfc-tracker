/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

/** Who is looking at the post. */
export type MeRsp = {username: string | null; isMod: boolean}

/** One certificate: [ref, title, language, category, secs, date, seq]. */
export type CertRow = [string, string, string, string, number, string, number]

/** Result of the last source post read. */
export type SyncInfo = {at: number; added: number; total: number; error: string}

/** All certificates, plus the last sync for mods. */
export type CertsRsp = {certs: CertRow[]; sync: SyncInfo | null}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Me: 'api/me',
  Certs: 'api/certs',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnMenuSync: 'internal/on/menu/sync',
  OnPostUpdate: 'internal/on/post-update',
  OnSchedulerSync: 'internal/scheduler/sync',
  ValidateSourcePost: 'internal/settings/source-post',
  ValidateInitialData: 'internal/settings/initial-data',
} as const

export const EndpointMethod = {
  [Endpoint.Me]: 'GET',
  [Endpoint.Certs]: 'GET',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnMenuSync]: 'POST',
  [Endpoint.OnPostUpdate]: 'POST',
  [Endpoint.OnSchedulerSync]: 'POST',
  [Endpoint.ValidateSourcePost]: 'POST',
  [Endpoint.ValidateInitialData]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
