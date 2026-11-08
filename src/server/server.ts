import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit, settings} from '@devvit/web/server'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'
import {
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type MeRsp,
} from '../shared/api.ts'

type AnyRsp = MeRsp | UiResponse | ErrorRsp

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpoint = reqMsg.url?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.Me:
        rsp = await routeMe()
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

async function routeMe(): Promise<MeRsp> {
  const user = await reddit.getCurrentUser()
  if (!user) return {username: null, isMod: false}
  const perms = context.subredditName
    ? await user.getModPermissionsForSubreddit(context.subredditName)
    : []
  return {username: user.username, isMod: perms.length > 0}
}

// "Add CBFC Tracker" (mod menu): the title comes from the subreddit's app settings.
async function routeMenuNewPost(): Promise<UiResponse> {
  const title =
    (await settings.get<string>('postTitle'))?.trim() ||
    '🎬 CBFC Certificates: Search & Watchlist (Unofficial)'
  const post = await reddit.submitCustomPost({title})
  return {
    showToast: {text: 'CBFC Tracker added', appearance: 'success'},
    navigateTo: post.url,
  }
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  rsp.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
