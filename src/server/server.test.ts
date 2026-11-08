import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {after, before, test} from 'node:test'
import {
  type Context,
  reddit,
  redis,
  runWithContext,
  settings,
} from '@devvit/web/server'
import {
  Endpoint,
  type ErrorRsp,
  type MeRsp,
  type NewRsp,
  type SearchRsp,
} from '../shared/api.ts'
import {onReq} from './server.ts'

let server: Server
let serverURL: string

// in-memory stand-ins for Redis and settings
const hashes = new Map<string, Map<string, string>>()
const nums = new Map<string, number>()
const strs = new Map<string, string>()
const hash = (k: string): Map<string, string> => {
  if (!hashes.has(k)) hashes.set(k, new Map())
  return hashes.get(k) as Map<string, string>
}
Object.assign(redis, {
  hMGet: async (k: string, f: string[]) => f.map(x => hash(k).get(x) ?? null),
  hSet: async (k: string, o: Record<string, string>) => {
    for (const [f, v] of Object.entries(o)) hash(k).set(f, v)
    return Object.keys(o).length
  },
  hGetAll: async (k: string) => Object.fromEntries(hash(k)),
  hLen: async (k: string) => hash(k).size,
  get: async (k: string) =>
    strs.get(k) ?? (nums.has(k) ? String(nums.get(k)) : undefined),
  set: async (k: string, v: string) => {
    strs.set(k, v)
    return 'OK'
  },
  incrBy: async (k: string, n: number) => {
    nums.set(k, (nums.get(k) ?? 0) + n)
    return nums.get(k)
  },
})
const sourcePost = `| Title | Language | Category | Length | Ref | When |
| - | - | - | - | - | - |
| DRISHYAM 3 | Malayalam | UA 13+ | 2h 33m 2s | TVM/1/45/2026 | 2026-11-06 D2 |
| A TRAILER | Tamil | U | 2m 10s | TRL/1/1/2026 | 2026-11-06 D2 |`
let initialData = ''
Object.assign(settings, {
  get: async (k: string) =>
    k === 'trackerPost' ? 't3_src' : k === 'initialData' ? initialData : '',
})
reddit.getPostById = async () => ({body: sourcePost}) as never

before(async () => {
  reddit.getCurrentUser = async () =>
    ({
      username: 'username',
      getModPermissionsForSubreddit: async () => ['all'],
    }) as never
  server = createServer(async (req, rsp) => {
    await runWithContext(
      {
        appName: 'cbfc-tracker',
        postId: 't3_123',
        subredditName: 'cbfc_tracker_dev',
        userId: 't2_123',
        username: 'username',
      } as unknown as Context,
      () => onReq(req, rsp),
    )
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const info = server.address() as AddressInfo
  serverURL = `http://127.0.0.1:${info.port}`
})

after(async () => {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()))
  })
})

test('me', async () => {
  const rsp = await fetch(`${serverURL}/${Endpoint.Me}`)
  assert.equal(rsp.status, 200)
  assert.deepEqual<MeRsp>(await rsp.json(), {username: 'username', isMod: true})
})

test('wrong method', async () => {
  const rsp = await fetch(`${serverURL}/${Endpoint.Me}`, {method: 'POST'})
  assert.equal(rsp.status, 404)
  assert.deepEqual<ErrorRsp>(await rsp.json(), {
    error: 'not found',
    status: 404,
  })
})

test('404', async () => {
  const rsp = await fetch(serverURL)
  assert.equal(rsp.status, 404)
})

const post = (endpoint: string, body: unknown): Promise<Response> =>
  fetch(`${serverURL}/${endpoint}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  })

test('initial data: checked on save, imported once by the next sync', async () => {
  const data = JSON.stringify([
    {
      ref: 'CHE/1/210/2026',
      title: 'ARIKOMBAN',
      language: 'Tamil',
      category: 'UA 13+',
      length: '2h 7s',
      date: '2026-01-08',
    },
    {
      ref: 'CHE/1/210/2026',
      title: 'ARIKOMBAN',
      language: 'Tamil',
      category: 'UA 13+',
      length: '2h 7s',
      date: '2026-01-08',
    },
  ])
  const rsp = await post(Endpoint.ValidateInitialData, {value: data})
  assert.deepEqual(await rsp.json(), {success: true})
  assert.equal(hash('certs').size, 0) // saving alone imports nothing
  initialData = data
  for (let i = 0; i < 2; i++) await post(Endpoint.OnSchedulerSync, {})
  assert.equal(hash('certs').has('CHE/1/210/2026'), true)
  assert.equal(strs.has('import'), true)
})

test('initial data: bad JSON is refused with a message', async () => {
  const rsp = await post(Endpoint.ValidateInitialData, {value: '{oops'})
  assert.deepEqual(await rsp.json(), {success: false, error: 'Not valid JSON'})
})

const get = async <T>(path: string): Promise<T> =>
  (await (await fetch(`${serverURL}/${path}`)).json()) as T

test('sync reads the source post; films only, newest first', async () => {
  const rsp = await post(Endpoint.OnSchedulerSync, {})
  assert.equal(rsp.status, 200)
  const all = await get<SearchRsp>(`${Endpoint.Search}?q=&page=0`)
  assert.equal(all.total, 2)
  assert.deepEqual(
    all.certs.map(c => c[0]),
    ['TVM/1/45/2026', 'CHE/1/210/2026'],
  )
})

test('search: one page of matches, total and exact title', async () => {
  const s = await get<SearchRsp>(`${Endpoint.Search}?q=drishyam&page=0`)
  assert.equal(s.total, 1)
  assert.equal(s.certs[0]?.[1], 'DRISHYAM 3')
  assert.equal(s.exact, false)
  const e = await get<SearchRsp>(`${Endpoint.Search}?q=arikomban&page=0`)
  assert.equal(e.exact, true)
  const none = await get<SearchRsp>(`${Endpoint.Search}?q=drisyam&page=0`)
  assert.deepEqual([none.total, none.certs.length], [0, 0])
})

test('new: counts only certificates after the follow seq', async () => {
  const n = await get<NewRsp>(
    `${Endpoint.New}?k=${encodeURIComponent('drishyam:0,drishyam:999,arikomban:0')}`,
  )
  assert.deepEqual(n.counts, [1, 0, 0]) // imported rows (seq 0) are never new
})

test('source post: errors show in settings', async () => {
  const check = async (value: string): Promise<unknown> =>
    (await post(Endpoint.ValidateSourcePost, {value})).json()
  assert.deepEqual(await check(''), {success: true})
  assert.deepEqual(await check('not a post'), {
    success: false,
    error: 'Post ID only, like 1abc2de',
  })
  assert.deepEqual(await check('t3_src'), {success: true})
  const real = reddit.getPostById
  reddit.getPostById = async () => ({body: 'hello'}) as never
  assert.deepEqual(await check('t3_src'), {
    success: false,
    error: 'No certificate table found',
  })
  reddit.getPostById = async () => {
    throw new Error('404')
  }
  assert.deepEqual(await check('t3_src'), {
    success: false,
    error: 'Post not found',
  })
  reddit.getPostById = real
})
