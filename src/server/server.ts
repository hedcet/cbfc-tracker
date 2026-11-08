import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit, redis, settings} from '@devvit/web/server'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'
import {
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type MeRsp,
  type NewRsp,
  type SearchRsp,
} from '../shared/api.ts'
import {parseJson, parseTable, postId} from './certs.ts'
import {importSetting, newCounts, searchCerts, syncSource} from './store.ts'

const TOOL_POST = 'post' // id of the one tool post

type ValidationRsp = {success: boolean; error?: string}
type EmptyRsp = Record<string, never>
type AnyRsp =
  | MeRsp
  | SearchRsp
  | NewRsp
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
  const url = new URL(reqMsg.url ?? '/', 'http://localhost')
  const endpoint = url.pathname.slice(1) as Endpoint
  const query = url.searchParams
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.Me:
        rsp = await routeMe()
        break
      case Endpoint.Search:
        rsp = await searchCerts(
          query.get('q') ?? '',
          Number(query.get('page')) || 0,
        )
        break
      case Endpoint.New:
        rsp = await newCounts(
          (query.get('k') ?? '').split(',').filter(Boolean).slice(0, 20),
        )
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
        await importSetting()
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
  if (!user) return {isMod: false, username: null}
  const perms = context.subredditName
    ? await user.getModPermissionsForSubreddit(context.subredditName)
    : []
  return {isMod: perms.length > 0, username: user.username}
}

// "Add CBFC Tracker" (mod menu): one tool post per subreddit; the title comes
// from settings. If it already exists (not removed), go there instead.
async function routeMenuNewPost(): Promise<UiResponse> {
  const old = await redis.get(TOOL_POST)
  if (old) {
    try {
      const post = await reddit.getPostById(old as `t3_${string}`)
      if (!post.removed && post.authorName !== '[deleted]')
        return {
          navigateTo: post.url,
          showToast: {appearance: 'neutral', text: 'Tracker already added'},
        }
    } catch {
      // gone: make a new one
    }
  }
  const title =
    (await settings.get<string>('postTitle'))?.trim() ||
    '🎬 CBFC Certificates: Search & Watchlist (Unofficial)'
  const post = await reddit.submitCustomPost({title})
  await redis.set(TOOL_POST, post.id)
  return {
    navigateTo: post.url,
    showToast: {appearance: 'success', text: 'CBFC Tracker added'},
  }
}

// "Sync CBFC data" (mod menu): read the source post now.
async function routeMenuSync(): Promise<UiResponse> {
  await importSetting()
  const s = await syncSource()
  return {
    showToast: s.error
      ? {appearance: 'neutral', text: s.error}
      : {
          appearance: 'success',
          text: `${s.total.toLocaleString('en-IN')} films · ${s.added} new`,
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
  if (!id) return {error: 'Post ID only, like 123456', success: false}
  let text = ''
  try {
    text = (await reddit.getPostById(id as `t3_${string}`)).body ?? ''
  } catch {
    return {error: 'Post not found', success: false}
  }
  if (!parseTable(text).length)
    return {error: 'No certificate table found', success: false}
  return {success: true}
}

// Initial data is only checked here; the next sync imports it (once), so a
// failed save never imports and other settings changes never re-import.
async function validateInitialData(body: unknown): Promise<ValidationRsp> {
  const value = String((body as {value?: unknown}).value ?? '').trim()
  if (!value) return {success: true}
  try {
    parseJson(value)
    return {success: true}
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      success: false,
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
