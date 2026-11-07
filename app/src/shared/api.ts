/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

/** Health check: proves the post can reach the app server. */
export type HealthRsp = {ok: true; username: string | null}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Health: 'api/health',
  OnMenuNewPost: 'internal/on/menu/new-post',
} as const

export const EndpointMethod = {
  [Endpoint.Health]: 'GET',
  [Endpoint.OnMenuNewPost]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
