/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

/** Who is looking at the post. */
export type MeRsp = {username: string | null; isMod: boolean}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Me: 'api/me',
  OnMenuNewPost: 'internal/on/menu/new-post',
} as const

export const EndpointMethod = {
  [Endpoint.Me]: 'GET',
  [Endpoint.OnMenuNewPost]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
