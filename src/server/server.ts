import type {IncomingMessage, ServerResponse} from 'node:http'
import {reddit, redis, settings} from '@devvit/web/server'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'
import {
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type MeRsp,
  type SearchRsp,
  type WatchActRsp,
  type WatchReq,
} from '../shared/api.ts'
import {parseTable, postId} from './certs.ts'
import {
  addPostRows,
  importSetting,
  importText,
  searchCerts,
  syncIfStale,
  syncSource,
} from './store.ts'
import {
  notifyNew,
  onModMail,
  postTitle,
  sendAlerts,
  sendDigests,
  TOOL_POST,
  viewer,
  watch,
} from './watch.ts'

type ValidationRsp = {success: boolean; error?: string}
type EmptyRsp = Record<string, never>
type AnyRsp =
  | MeRsp
  | SearchRsp
  | WatchActRsp
  | UiResponse
  | ValidationRsp
  | ErrorRsp
  | EmptyRsp

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
  const post = await reddit.submitCustomPost({title: await postTitle()})
  await redis.set(TOOL_POST, post.id)
  return {
    navigateTo: post.url,
    showToast: {appearance: 'success', text: 'CBFC Tracker added'},
  }
}

// cbfc.js edited the source post: read it right away.
async function routePostUpdate(body: unknown): Promise<EmptyRsp> {
  const post = (body as {post?: {id?: string}}).post
  const source = postId((await settings.get<string>('trackerPost')) ?? '')
  console.log(`post update: ${post?.id ?? '?'} (source ${source || 'not set'})`)
  if (post?.id && post.id === source)
    await notifyNew((await syncSource()).added)
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
  const rows = parseTable(text)
  if (!rows.length) return {error: 'No certificate table found', success: false}
  await notifyNew(await addPostRows(rows)) // stored right away, no wait for the hourly sync
  return {success: true}
}

// Initial data is checked and imported on save (once per distinct text).
async function validateInitialData(body: unknown): Promise<ValidationRsp> {
  const value = String((body as {value?: unknown}).value ?? '').trim()
  if (!value) return {success: true}
  try {
    await importText(value)
    return {success: true}
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      success: false,
    }
  }
}

async function step(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    console.error(err)
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
        rsp = await viewer()
        break
      case Endpoint.Search:
        // opening the post (first page, no query) also catches missed source edits
        if (!query.get('q') && !Number(query.get('page')))
          await notifyNew(await syncIfStale())
        rsp = await searchCerts(
          query.get('q') ?? '',
          Number(query.get('page')) || 0,
        )
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      case Endpoint.OnModMail:
        await onModMail(await readJson(reqMsg))
        rsp = {}
        break
      case Endpoint.OnPostUpdate:
        rsp = await routePostUpdate(await readJson(reqMsg))
        break
      case Endpoint.OnSchedulerAlerts:
        await sendAlerts()
        rsp = {}
        break
      case Endpoint.OnSchedulerSync:
        // each step on its own: one failing does not block the others
        await step(importSetting)
        await step(async () => notifyNew((await syncSource()).added))
        await step(sendAlerts) // new alerts first, so grouped messages include them
        await step(sendDigests)
        rsp = {}
        break
      case Endpoint.ValidateSourcePost:
        rsp = await validateSourcePost(await readJson(reqMsg))
        break
      case Endpoint.ValidateInitialData:
        rsp = await validateInitialData(await readJson(reqMsg))
        break
      case Endpoint.Watch:
        rsp = await watch((await readJson(reqMsg)) as Partial<WatchReq>)
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
