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
  type CertsRsp,
  Endpoint,
  type ErrorRsp,
  type MeRsp,
} from '../shared/api.ts'
import {onReq} from './server.ts'

let server: Server
let serverURL: string

// in-memory stand-ins for Redis and settings
const hashes = new Map<string, Map<string, string>>()
const nums = new Map<string, number>()
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
  incrBy: async (k: string, n: number) => {
    nums.set(k, (nums.get(k) ?? 0) + n)
    return nums.get(k)
  },
})
const sourcePost = `| Title | Language | Category | Length | Ref | When |
| - | - | - | - | - | - |
| DRISHYAM 3 | Malayalam | UA 13+ | 2h 33m 2s | TVM/1/45/2026 | 2026-11-06 D2 |
| A TRAILER | Tamil | U | 2m 10s | TRL/1/1/2026 | 2026-11-06 D2 |`
Object.assign(settings, {
  get: async (k: string) => (k === 'trackerPost' ? 't3_src' : undefined),
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

test('initial data: imported on save, duplicates by ref skipped', async () => {
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
  for (let i = 0; i < 2; i++) {
    const rsp = await post(Endpoint.ValidateInitialData, {value: data})
    assert.deepEqual(await rsp.json(), {success: true})
  }
  assert.equal(hash('certs').size, 1)
})

test('initial data: bad JSON is refused with a message', async () => {
  const rsp = await post(Endpoint.ValidateInitialData, {value: '{oops'})
  assert.deepEqual(await rsp.json(), {success: false, error: 'Not valid JSON'})
})

test('sync reads the source post; films only', async () => {
  const rsp = await post(Endpoint.OnSchedulerSync, {})
  assert.equal(rsp.status, 200)
  const certs = (await (
    await fetch(`${serverURL}/${Endpoint.Certs}`)
  ).json()) as CertsRsp
  assert.deepEqual(certs.certs.map(c => c[0]).sort(), [
    'CHE/1/210/2026',
    'TVM/1/45/2026',
  ])
})

test('source post: errors show in settings', async () => {
  const check = async (value: string): Promise<unknown> =>
    (await post(Endpoint.ValidateSourcePost, {value})).json()
  assert.deepEqual(await check(''), {success: true})
  assert.deepEqual(await check('not a post'), {
    success: false,
    error: 'Use a post link or ID',
  })
  assert.deepEqual(await check('t3_src'), {success: true})
  const real = reddit.getPostById
  reddit.getPostById = async () => ({body: 'hello'}) as never
  assert.deepEqual(await check('t3_src'), {
    success: false,
    error: 'No certificate table in this post',
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
