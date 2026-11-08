import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit, settings} from '@devvit/web/server'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'
import {
  type CertsRsp,
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type MeRsp,
} from '../shared/api.ts'
import {parseTable, postId} from './certs.ts'
import {allCerts, importJson, syncSource} from './store.ts'

type ValidationRsp = {success: boolean; error?: string}
type EmptyRsp = Record<string, never>
type AnyRsp =
  | MeRsp
  | CertsRsp
  | UiResponse
  | ValidationRsp
  | ErrorRsp
  | EmptyRsp

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
  const endpoint = reqMsg.url?.split('?')[0]?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.Me:
        rsp = await routeMe()
        break
      case Endpoint.Certs:
        rsp = {certs: await allCerts()}
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      case Endpoint.OnMenuSync:
        rsp = await routeMenuSync()
        break
      case Endpoint.OnPostUpdate:
        rsp = await routePostUpdate(await readJson(reqMsg))
        break
      case Endpoint.OnSchedulerSync:
        await syncSource()
        rsp = {}
        break
      case Endpoint.ValidateSourcePost:
        rsp = await validateSourcePost(await readJson(reqMsg))
        break
      case Endpoint.ValidateInitialData:
        rsp = await validateInitialData(await readJson(reqMsg))
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>(
    'status' in rsp ? rsp.status : 200,
    rsp as PartialJsonValue,
    rspMsg,
  )
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

// "Sync CBFC data" (mod menu): read the source post now.
async function routeMenuSync(): Promise<UiResponse> {
  const s = await syncSource()
  return {
    showToast: s.error
      ? {text: s.error, appearance: 'neutral'}
      : {
          text: `${s.total.toLocaleString('en-IN')} films · ${s.added} new`,
          appearance: 'success',
        },
  }
}

// cbfc.js edited the source post: read it right away.
async function routePostUpdate(body: unknown): Promise<EmptyRsp> {
  const post = (body as {post?: {id?: string}}).post
  const source = postId((await settings.get<string>('trackerPost')) ?? '')
  console.log(`post update: ${post?.id ?? '?'} (source ${source || 'not set'})`)
  if (post?.id && post.id === source) await syncSource()
  return {}
}

async function validateSourcePost(body: unknown): Promise<ValidationRsp> {
  const value = String((body as {value?: unknown}).value ?? '').trim()
  if (!value) return {success: true} // optional: without it, the tool is search only
  const id = postId(value)
  if (!id) return {success: false, error: 'Use the post ID, e.g. 1abc2de'}
  let text = ''
  try {
    text = (await reddit.getPostById(id as `t3_${string}`)).body ?? ''
  } catch {
    return {success: false, error: 'Post not found'}
  }
  if (!parseTable(text).length)
    return {success: false, error: 'No certificate table in this post'}
  return {success: true}
}

// Initial data is imported when the settings are saved; Ref decides duplicates.
async function validateInitialData(body: unknown): Promise<ValidationRsp> {
  const value = String((body as {value?: unknown}).value ?? '').trim()
  if (!value) return {success: true}
  try {
    const {added, skipped} = await importJson(value)
    console.log(`initial data: ${added} added, ${skipped} skipped`)
    return {success: true}
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
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
