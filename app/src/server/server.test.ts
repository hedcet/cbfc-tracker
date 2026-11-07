import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {after, before, test} from 'node:test'
import {type Context, reddit, runWithContext} from '@devvit/web/server'
import {Endpoint, type ErrorRsp, type MeRsp} from '../shared/api.ts'
import {onReq} from './server.ts'

let server: Server
let serverURL: string

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
