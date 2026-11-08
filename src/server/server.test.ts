import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {after, before, test} from 'node:test'
import {
  type Context,
  reddit,
  redis,
  runWithContext,
  scheduler,
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
const expires = new Map<string, number>()
const hash = (k: string): Map<string, string> => {
  if (!hashes.has(k)) hashes.set(k, new Map())
  return hashes.get(k) as Map<string, string>
}
Object.assign(redis, {
  del: async (...keys: string[]) => {
    for (const k of keys) {
      hashes.delete(k)
      strs.delete(k)
    }
  },
  get: async (k: string) =>
    (expires.get(k) ?? Number.POSITIVE_INFINITY) < Date.now()
      ? undefined
      : (strs.get(k) ?? (nums.has(k) ? String(nums.get(k)) : undefined)),
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
  set: async (k: string, v: string, o?: {expiration?: Date}) => {
    strs.set(k, v)
    if (o?.expiration) expires.set(k, o.expiration.getTime())
    else expires.delete(k)
    return 'OK'
  },
})
// scheduler: jobs are recorded; tests run the alerts job themselves
const jobs: string[] = []
Object.assign(scheduler, {
  runJob: async (o: {name: string}) => {
    jobs.push(o.name)
    return o.name
  },
})
const sourcePost = `| Title | Language | Category | Length | Ref | When |
| - | - | - | - | - | - |
| DRISHYAM 3 | Malayalam | UA 13+ | 2h 33m 2s | TVM/1/45/2026 | 2026-11-06 D2 |
| A TRAILER | Tamil | U | 2m 10s | TRL/1/1/2026 | 2026-11-06 D2 |`
let initialData = ''
let archiveOn = false
Object.assign(settings, {
  get: async (k: string) =>
    k === 'trackerPost'
      ? 't3_src'
      : k === 'initialData'
        ? initialData
        : k === 'archivePost'
          ? archiveOn
          : '',
})
// daily archive posts, recorded
const posts: {text: string; title: string}[] = []
// posts are approved and get the MOD badge
const modded: string[] = []
reddit.submitPost = (async (o: {text: string; title: string}) => {
  posts.push(o)
  return {
    approve: async () => {
      modded.push('approve')
    },
    distinguish: async () => {
      modded.push('distinguish')
    },
    id: 't3_arch',
  }
}) as never
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

const send = (endpoint: string, body: unknown): Promise<Response> =>
  fetch(`${serverURL}/${endpoint}`, {
    body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
  })
// internal endpoints are called by Reddit: no user (like the scheduler)
const post = async (endpoint: string, body: unknown): Promise<Response> => {
  if (!endpoint.startsWith('internal/')) return send(endpoint, body)
  const as = user
  user = {mod: false, name: ''}
  try {
    return await send(endpoint, body)
  } finally {
    user = as
  }
}

test('security: internal endpoints refuse logged-in non-mods', async () => {
  user = {mod: false, name: 'mallory'}
  for (const e of [
    Endpoint.OnSchedulerArchive,
    Endpoint.OnSchedulerSync,
    Endpoint.ValidateInitialData,
    Endpoint.OnMenuNewPost,
  ])
    assert.equal((await send(e, {})).status, 403, e)
  user = {mod: true, name: 'username'} // mods (menu, settings) may
  assert.equal((await send(Endpoint.OnSchedulerSync, {})).status, 200)
})

test('security: unknown action, oversized body, no stack trace', async () => {
  const r = (await (
    await send(Endpoint.Watch, {act: 'drop', word: 'x'})
  ).json()) as ErrorRsp
  assert.deepEqual(r, {error: 'Unknown action', status: 400})
  const big = await fetch(`${serverURL}/${Endpoint.Watch}`, {
    body: 'x'.repeat(11 * 1024 * 1024),
    method: 'POST',
  })
  assert.deepEqual(await big.json(), {error: 'server error', status: 500})
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
  assert.equal(hash('certs').size, 3) // + 2 from the source post (film, trailer); no duplicates
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

test('search: one page of matches and the total', async () => {
  const s = await get<SearchRsp>(`${Endpoint.Search}?q=drishyam&page=0`)
  assert.equal(s.total, 1)
  assert.equal(s.certs[0]?.[1], 'DRISHYAM 3')
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

// message limits: start each test from a clean slate; age a grouped mode
const resetLimits = (): Promise<unknown> => redis.del('rate', 'digest', 'mode')
const ageMode = (name: string, m: string, ms: number): Promise<unknown> =>
  redis.hSet('mode', {[name]: JSON.stringify({at: Date.now() - ms, m})})
const withSource = async (rows: string, run: () => Promise<unknown>) => {
  reddit.getPostById = async () => ({body: `${sourcePost}\n${rows}`}) as never
  await run()
  reddit.getPostById = async () => ({body: sourcePost}) as never
}

test('watch: new certificates send one alert per follower', async () => {
  user = {mod: false, name: 'bob'}
  await watch({act: 'follow', word: 'drishyam'}) // bob already has 3
  user = {mod: false, name: 'cat'}
  await watch({act: 'follow', word: 'drishyam'})
  await watch({act: 'follow', word: 'kerala'})
  await post(Endpoint.OnSchedulerAlerts, {}) // earlier tests' queue
  await resetLimits()
  const before = sent.length
  await withSource(
    `| DRISHYAM KERALA | Malayalam | U | 2h 10m | TVM/1/99/2026 | 2026-11-07 D1 |
| DRISHYAM 4 | Tamil | UA 13+ | 2h 1m | CHE/1/99/2026 | 2026-11-07 D1 |`,
    () => post(Endpoint.OnPostUpdate, {post: {id: 't3_src'}}),
  )
  assert.equal(sent.length, before) // the edit only queues
  assert.equal(jobs.at(-1), 'alerts')
  await post(Endpoint.OnSchedulerAlerts, {})
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

test('hourly run: sends waiting alerts itself (a lost job is no problem)', async () => {
  await resetLimits()
  const before = sent.length
  await withSource(
    '| DRISHYAM 5 | Telugu | U | 2h 3m | HYD/1/5/2026 | 2026-11-08 D1 |',
    () => post(Endpoint.OnSchedulerSync, {}),
  )
  assert.deepEqual(
    sent
      .slice(before)
      .map(m => m.to)
      .sort(),
    ['ann', 'cat'],
  )
})

test('watch: unfollow passes ownership on; last one out deletes', async () => {
  await resetLimits()
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

test('limits: 3rd message in an hour waits; toggled back = nothing', async () => {
  await resetLimits()
  user = {mod: false, name: 'dan'}
  const toDan = (): string[] =>
    sent.filter(m => m.to === 'dan').map(m => m.body.split('\n')[0] ?? '')
  await watch({act: 'follow', word: 'toxic'}) // 1st this hour: now
  await watch({act: 'unfollow', word: 'toxic'}) // 2nd: now
  await watch({act: 'follow', word: 'toxic'}) // 3rd: held, hourly mode
  await watch({act: 'unfollow', word: 'toxic'}) // held: back to OFF
  await post(Endpoint.OnSchedulerSync, {}) // OFF already told: nothing
  assert.deepEqual(toDan(), [
    '**Keyword added: TOXIC**  ',
    '**Keyword removed: TOXIC**  ',
  ])
  await watch({act: 'follow', word: 'toxic'}) // still hourly: held
  await post(Endpoint.OnSchedulerSync, {})
  const last = sent.filter(m => m.to === 'dan').at(-1)?.body ?? ''
  assert.match(
    last,
    /^📦 \*\*1 update, grouped\*\* · max 2 messages\/hour\n\n🔔 Alerts \*\*ON\*\*: TOXIC {2}\nNot interested\? \[Unfollow\]/,
  )
})

test('limits: hourly mode ends after a full hour with at most 2', async () => {
  await resetLimits()
  user = {mod: false, name: 'dan'}
  await watch({act: 'unfollow', word: 'toxic'}) // instant
  await watch({act: 'follow', word: 'toxic'}) // instant
  await watch({act: 'unfollow', word: 'toxic'}) // held: hourly mode
  await post(Endpoint.OnSchedulerSync, {}) // the starting hour: no review
  assert.ok(await redis.hGet('mode', 'dan'))
  await ageMode('dan', 'hourly', 3600_000) // a full hour, nothing held
  await post(Endpoint.OnSchedulerSync, {})
  assert.equal(await redis.hGet('mode', 'dan'), undefined) // instant again
  await ageMode('dan', 'hourly', 3600_000)
  await redis.hSet('digest', {
    dan: JSON.stringify({films: [], msgs: 3, notes: {}}),
  })
  await post(Endpoint.OnSchedulerSync, {}) // 3 held in the hour: stays
  assert.ok(await redis.hGet('mode', 'dan'))
})

test('limits: over 8 a day, one grouped message a day', async () => {
  await resetLimits()
  const earlier = Date.now() - 3 * 3600_000 // 8 today, none this hour
  await redis.hSet('rate', {dan: JSON.stringify(Array(8).fill(earlier))})
  user = {mod: false, name: 'dan'}
  const before = sent.length
  await watch({act: 'follow', word: 'toxic'}) // 9th today: held, daily
  assert.match((await redis.hGet('mode', 'dan')) ?? '', /"m":"daily"/)
  await post(Endpoint.OnSchedulerSync, {}) // not a day yet
  assert.equal(sent.length, before)
  await ageMode('dan', 'daily', 24 * 3600_000)
  await post(Endpoint.OnSchedulerSync, {})
  assert.match(
    sent.at(-1)?.body ?? '',
    /^📦 \*\*1 update, grouped\*\* · max 8 messages\/day/,
  )
  assert.equal(await redis.hGet('mode', 'dan'), undefined) // 1 held: normal
})

test('limits: a failed send is kept for the next run', async () => {
  await resetLimits()
  user = {mod: false, name: 'dan'}
  const {createConversation, reply} = reddit.modMail
  const fail = async (): Promise<never> => {
    throw new Error('down')
  }
  Object.assign(reddit.modMail, {createConversation: fail, reply: fail})
  await watch({act: 'unfollow', word: 'toxic'}) // fails: held
  await ageMode('dan', 'hourly', 3600_000)
  await post(Endpoint.OnSchedulerSync, {}) // fails again: still held
  Object.assign(reddit.modMail, {createConversation, reply})
  assert.ok(await redis.hGet('digest', 'dan'))
  const before = sent.length
  await post(Endpoint.OnSchedulerSync, {})
  assert.match(sent.at(-1)?.body ?? '', /🔕 Alerts \*\*OFF\*\*: TOXIC/)
  assert.equal(sent.length, before + 1)
})

test('alerts: over 2 an hour, the rest wait for the grouped message', async () => {
  user = {mod: false, name: 'eve'}
  await watch({act: 'follow', word: 'leo'})
  user = {mod: false, name: 'fay'}
  await watch({act: 'follow', word: 'leo'})
  await resetLimits()
  const now = Date.now()
  await redis.hSet('rate', {
    eve: JSON.stringify([now, now]), // already 2 this hour
    fay: JSON.stringify([now - 2 * 3600_000, now]), // 1 this hour
  })
  const before = sent.length
  await withSource(
    '| LEO | Tamil | UA 16+ | 2h 44m | CHE/1/7/2026 | 2026-11-08 D1 |',
    () => post(Endpoint.OnPostUpdate, {post: {id: 't3_src'}}),
  )
  await post(Endpoint.OnSchedulerAlerts, {})
  assert.deepEqual(
    sent.slice(before).map(m => m.to),
    ['fay'],
  )
  await post(Endpoint.OnSchedulerSync, {}) // the hourly run
  const eve = sent.slice(before).filter(m => m.to === 'eve')
  assert.equal(eve.length, 1)
  assert.match(
    eve[0]?.body ?? '',
    /^📦 \*\*1 update, grouped\*\*.*\n\n\*\*LEO: 1 new certificate\*\*/,
  )
})

test('alerts: at most 5 a keyword, 10 in all, then "+N more"', async () => {
  user = {mod: true, name: 'gus'}
  for (const w of ['zeta', 'zulu']) await watch({act: 'follow', word: w})
  await resetLimits()
  const row = (t: string, i: number): string =>
    `| ${t} | Tamil | U | 2h 1m | ${t.replace(/\W/g, '')}/1/${i}/2026 | 2026-11-08 D1 |`
  const rows = [
    ...Array.from({length: 7}, (_, i) => row(`ZETA ${i + 1}`, i)),
    ...Array.from({length: 2}, (_, i) => row(`ZULU ${i + 1}`, i)),
    row('1. ZETA^2', 99), // list marker and superscript stay literal
  ].join('\n')
  await withSource(rows, () => post(Endpoint.OnSchedulerSync, {}))
  const body = sent.filter(m => m.to === 'gus').at(-1)?.body ?? ''
  assert.match(body, /^\*\*ZETA, ZULU: 10 new certificates\*\*/)
  // ZETA: 8 films, 5 shown; ZULU: 2 shown
  assert.match(
    body,
    /\*\*ZETA\*\* {2}\n(.+ {2}\n){5}\*\*\+3 more\*\*\n\n\*\*ZULU\*\*/,
  )
  assert.match(body, /1\\\. ZETA\\\^2/)
})

test('alerts: at most 5 keywords in a heading', async () => {
  user = {mod: true, name: 'hal'}
  const ws = ['kalam', 'kalari', 'kalyan', 'kalki', 'kalpana', 'kalavu']
  for (const w of ws) await watch({act: 'follow', word: w})
  await resetLimits()
  await withSource(
    '| KALAMKALARIKALYANKALKIKALPANAKALAVU | Tamil | U | 2h | KK/1/1/2026 | 2026-11-08 D1 |',
    () => post(Endpoint.OnSchedulerSync, {}),
  )
  assert.match(
    sent.filter(m => m.to === 'hal').at(-1)?.body ?? '',
    /^\*\*KALAM, KALARI, KALAVU, KALKI, KALPANA \+1 more: 1 new certificate\*\*/,
  )
})

test('archive: one post a day with every new item, then marked posted', async () => {
  await post(Endpoint.OnSchedulerArchive, {}) // switched off: nothing
  assert.equal(posts.length, 0)
  archiveOn = true
  await post(Endpoint.OnSchedulerArchive, {})
  archiveOn = false
  const p = posts.at(-1)
  assert.match(
    p?.title ?? '',
    /^🎬 CBFC certificates · \d{4}-\d{2}-\d{2} \(\d+\)$/,
  )
  const text = p?.text ?? ''
  assert.match(
    text,
    /^\| Title \| Language \| Category \| Length \| Ref \| When \|\n\|---\|/,
  )
  // short items too (the trailer), When without "D2"
  assert.match(
    text,
    /\| A TRAILER \| Tamil \| U \| 2m 10s \| TRL\/1\/1\/2026 \| 2026-11-06 \|/,
  )
  assert.doesNotMatch(text, /D2/)
  assert.deepEqual(modded, ['approve', 'distinguish']) // no mod queue, MOD badge
  // the initial data import counts as posted
  assert.doesNotMatch(text, /ARIKOMBAN/)
  archiveOn = true
  await post(Endpoint.OnSchedulerArchive, {}) // nothing new: no second post
  archiveOn = false
  assert.equal(posts.length, 1)
})

test('archive: too long for one post is trimmed', async () => {
  const {archiveText} = await import('./archive.ts')
  const c = {category: 'U', date: '2026-11-08', language: 'Hindi', secs: 28}
  const many = Array.from({length: 900}, (_, i) => ({
    ...c,
    ref: `AD/${i}/2026`,
    title: `AD FILM ${i} | WITH A PIPE`,
  }))
  const text = archiveText(many)
  assert.ok(text.length <= 40_000)
  assert.match(text, /\n\n…and \d+ more not shown$/)
  assert.match(text, /AD FILM 0 \\\| WITH A PIPE/)
  // markdown in titles stays literal
  const odd = archiveText([{...c, ref: 'X/1', title: '[AD] *NEW*_1'}])
  assert.match(odd, /\| \\\[AD\\\] \\\*NEW\\\*\\_1 \|/)
})

test('archive: a failed post is tried again the next night', async () => {
  reddit.getPostById = async () =>
    ({
      body: `${sourcePost}\n| SHORT AD | Hindi | U | 28s | AD/9/9/2026 | 2026-11-08 D1 |`,
    }) as never
  await post(Endpoint.OnSchedulerSync, {})
  reddit.getPostById = async () => ({body: sourcePost}) as never
  const submit = reddit.submitPost
  reddit.submitPost = (async () => {
    throw new Error('down')
  }) as never
  archiveOn = true
  await post(Endpoint.OnSchedulerArchive, {}) // fails: nothing marked posted
  reddit.submitPost = submit
  await post(Endpoint.OnSchedulerArchive, {})
  archiveOn = false
  assert.match(posts.at(-1)?.text ?? '', /\| SHORT AD \| Hindi \| U \| 28s \|/)
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
    '🤖 **Automated alerts thread** · replies aren’t read, sorry.',
  )
})
