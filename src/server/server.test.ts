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
  type SearchRsp,
  type WatchActRsp,
  type WatchRsp,
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
  del: async (...keys: string[]) => {
    for (const k of keys) hashes.delete(k)
  },
  get: async (k: string) =>
    strs.get(k) ?? (nums.has(k) ? String(nums.get(k)) : undefined),
  hDel: async (k: string, f: string[]) => {
    for (const x of f) hash(k).delete(x)
    return f.length
  },
  hGet: async (k: string, f: string) => hash(k).get(f),
  hGetAll: async (k: string) => Object.fromEntries(hash(k)),
  hKeys: async (k: string) => [...hash(k).keys()],
  hLen: async (k: string) => hash(k).size,
  hMGet: async (k: string, f: string[]) => f.map(x => hash(k).get(x) ?? null),
  hSet: async (k: string, o: Record<string, string>) => {
    for (const [f, v] of Object.entries(o)) hash(k).set(f, v)
    return Object.keys(o).length
  },
  incrBy: async (k: string, n: number) => {
    nums.set(k, (nums.get(k) ?? 0) + n)
    return nums.get(k)
  },
  set: async (k: string, v: string) => {
    strs.set(k, v)
    return 'OK'
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

// modmail: one conversation per user, every message recorded
const sent: {to: string; body: string}[] = []
const convTo = new Map<string, string>()
Object.assign(reddit.modMail, {
  archiveConversation: async () => ({}),
  createConversation: async (o: {
    to: string
    body: string
    isAuthorHidden?: boolean
  }) => {
    assert.equal(o.isAuthorHidden, true) // sent as the subreddit
    const id = `c${convTo.size + 1}`
    convTo.set(id, o.to)
    sent.push({body: o.body, to: o.to})
    return {conversation: {id}}
  },
  reply: async (o: {
    conversationId: string
    body: string
    isAuthorHidden?: boolean
  }) => {
    assert.equal(o.isAuthorHidden, true) // sent as the subreddit
    sent.push({body: o.body, to: convTo.get(o.conversationId) ?? '?'})
    return {conversation: {id: o.conversationId}}
  },
})

// who is asking: change between requests to act as another user
let user = {mod: true, name: 'username'}

before(async () => {
  reddit.getCurrentUser = async () =>
    ({
      getModPermissionsForSubreddit: async () => (user.mod ? ['all'] : []),
      username: user.name,
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
  assert.deepEqual<MeRsp>(await rsp.json(), {isMod: true, username: 'username'})
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
    body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
  })

test('initial data: checked and imported on save, only once', async () => {
  const data = JSON.stringify([
    {
      category: 'UA 13+',
      date: '2026-01-08',
      language: 'Tamil',
      length: '2h 7s',
      ref: 'CHE/1/210/2026',
      title: 'ARIKOMBAN',
    },
    {
      category: 'UA 13+',
      date: '2026-01-08',
      language: 'Tamil',
      length: '2h 7s',
      ref: 'CHE/1/210/2026',
      title: 'ARIKOMBAN',
    },
  ])
  const rsp = await post(Endpoint.ValidateInitialData, {value: data})
  assert.deepEqual(await rsp.json(), {success: true})
  assert.equal(hash('certs').has('CHE/1/210/2026'), true)
  assert.equal(strs.has('import'), true)
  await post(Endpoint.ValidateInitialData, {value: data}) // same text again
  initialData = data
  await post(Endpoint.OnSchedulerSync, {}) // and the hourly sync
  assert.equal(hash('certs').size, 2) // + 1 from the source post; no duplicates
})

test('initial data: bad JSON is refused with a message', async () => {
  const rsp = await post(Endpoint.ValidateInitialData, {value: '{oops'})
  const out = (await rsp.json()) as {success: boolean; error: string}
  assert.equal(out.success, false)
  assert.match(out.error, /JSON|token|property/i) // the parser's message
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

const watch = async (body: object = {}): Promise<WatchActRsp> =>
  (await post(Endpoint.Watch, body)).json() as Promise<WatchActRsp>
const words = (r: WatchActRsp): string[] =>
  'keywords' in r ? r.keywords.map(k => k.word) : []

test('watch: follow sends a welcome; private keywords only for followers and mods', async () => {
  user = {mod: false, name: 'ann'}
  const r = (await watch({act: 'follow', word: 'Drishyam'})) as WatchRsp
  assert.deepEqual(words(r), ['drishyam'])
  assert.equal(r.keywords[0]?.owner, 'ann')
  assert.equal(r.keywords[0]?.public, false) // only mods make it public
  assert.equal(r.keywords[0]?.fresh, 0) // counts from the follow
  // exactly as agreed: three lines, Unfollow is a link to the tracker post
  assert.equal(
    sent.at(-1)?.body,
    [
      '**Keyword added: DRISHYAM**',
      '🔔 Alerts **ON** for titles containing DRISHYAM.',
      'Not interested? [Unfollow](https://www.reddit.com/r/cbfc_tracker_dev/comments/123/)',
    ].join('  \n'),
  )
  user = {mod: false, name: 'bob'}
  assert.deepEqual(words(await watch()), []) // not public yet
  user = {mod: true, name: 'username'}
  await watch({act: 'public', word: 'drishyam'})
  user = {mod: false, name: 'bob'}
  assert.deepEqual(words(await watch()), ['drishyam'])
  assert.deepEqual(await watch({act: 'public', word: 'drishyam'}), {
    error: 'Mods only',
    status: 400,
  })
})

test('watch: rules', async () => {
  user = {mod: false, name: 'bob'}
  const err = async (word: string): Promise<string> =>
    ((await watch({act: 'follow', word})) as {error: string}).error
  assert.equal(await err('the'), 'Too common, try another')
  assert.equal(await err('x'), '2–20 letters or digits')
  for (const w of ['toxic', 'kantara', 'coolie'])
    assert.deepEqual(
      words(await watch({act: 'follow', word: w})).includes(w),
      true,
    )
  assert.equal(await err('empuraan'), 'Limit: 3 keywords')
  assert.equal(await err('toxic'), 'Already following TOXIC')
  user = {mod: false, name: ''}
  assert.equal(await err('ramayana'), 'Log in first')
})

test('watch: new certificates send one alert per follower', async () => {
  user = {mod: false, name: 'bob'}
  await watch({act: 'follow', word: 'drishyam'}) // bob already has 3
  user = {mod: false, name: 'cat'}
  await watch({act: 'follow', word: 'drishyam'})
  await watch({act: 'follow', word: 'kerala'})
  const before = sent.length
  reddit.getPostById = async () =>
    ({
      body: `${sourcePost}
| DRISHYAM KERALA | Malayalam | U | 2h 10m | TVM/1/99/2026 | 2026-11-07 D1 |
| DRISHYAM 4 | Tamil | UA 13+ | 2h 1m | CHE/1/99/2026 | 2026-11-07 D1 |`,
    }) as never
  await post(Endpoint.OnSchedulerSync, {})
  reddit.getPostById = async () => ({body: sourcePost}) as never
  const alerts = sent.slice(before)
  assert.deepEqual(alerts.map(a => a.to).sort(), ['ann', 'cat'])
  const cat = alerts.find(a => a.to === 'cat')?.body ?? ''
  assert.match(cat, /^\*\*DRISHYAM, KERALA: 2 new certificates\*\*/)
  assert.equal(cat.split('DRISHYAM KERALA ·').length, 2) // listed once
  assert.doesNotMatch(cat, /Unfollow/)
  user = {mod: false, name: 'ann'}
  const r = (await watch()) as WatchRsp
  assert.equal(r.keywords.find(k => k.word === 'drishyam')?.fresh, 2)
})

test('watch: unfollow passes ownership on; last one out deletes', async () => {
  user = {mod: false, name: 'ann'}
  await watch({act: 'unfollow', word: 'drishyam'})
  assert.match(
    sent.at(-1)?.body ?? '',
    /Keyword removed: DRISHYAM[\s\S]*Alerts \*\*OFF\*\*/,
  )
  user = {mod: true, name: 'username'}
  const r = (await watch()) as WatchRsp
  assert.equal(r.keywords.find(k => k.word === 'drishyam')?.owner, 'cat')
  user = {mod: false, name: 'cat'}
  await watch({act: 'unfollow', word: 'kerala'})
  user = {mod: true, name: 'username'}
  assert.equal(words(await watch()).includes('kerala'), false)
  // one conversation per user: every message to cat is in the same thread
  assert.equal([...convTo.values()].filter(u => u === 'cat').length, 1)
})

test('source post: errors show in settings', async () => {
  const check = async (value: string): Promise<unknown> =>
    (await post(Endpoint.ValidateSourcePost, {value})).json()
  assert.deepEqual(await check(''), {success: true})
  assert.deepEqual(await check('not a post'), {
    error: 'Post ID only, like 123456',
    success: false,
  })
  assert.deepEqual(await check('t3_src'), {success: true})
  const real = reddit.getPostById
  reddit.getPostById = async () => ({body: 'hello'}) as never
  assert.deepEqual(await check('t3_src'), {
    error: 'No certificate table found',
    success: false,
  })
  reddit.getPostById = async () => {
    throw new Error('404')
  }
  assert.deepEqual(await check('t3_src'), {
    error: 'Post not found',
    success: false,
  })
  reddit.getPostById = real
})

test('watch: mods (not archivable) still get one conversation', async () => {
  const archive = reddit.modMail.archiveConversation
  reddit.modMail.archiveConversation = async () => {
    throw new Error('Cannot archive/unarchive internal conversations.')
  }
  user = {mod: true, name: 'modx'}
  await watch({act: 'follow', word: 'aadu'})
  await watch({act: 'unfollow', word: 'aadu'})
  reddit.modMail.archiveConversation = archive
  assert.equal(sent.filter(m => m.to === 'modx').length, 2)
  assert.equal([...convTo.values()].filter(u => u === 'modx').length, 1)
})

test('reply in an alerts thread: one automatic answer a day', async () => {
  const conv = [...convTo].find(([, u]) => u === 'cat')?.[0] ?? ''
  const before = sent.length
  const reply = (
    author = 'cat',
    type = 'participant_user',
  ): Promise<Response> =>
    post(Endpoint.OnModMail, {
      conversationId: conv,
      messageAuthor: {name: author},
      messageAuthorType: type,
    })
  await reply()
  await reply() // same day: no second answer
  await reply('cat', 'moderator') // our own message: ignored
  const answers = sent.slice(before)
  assert.equal(answers.length, 1)
  assert.equal(answers[0]?.to, 'cat')
  assert.equal(
    answers[0]?.body,
    '🤖 **This is an automated alerts thread**  \nReplies here aren’t read, sorry.',
  )
})
