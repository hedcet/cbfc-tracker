import {Endpoint, type HealthRsp} from '../shared/api.ts'

// Day-1 skeleton: proves the post loads and can reach the app server.
// Phase 2 replaces this with the Watchlist / Search UI from reddit/prototype.html.
const status = document.getElementById('status') as HTMLElement

async function main(): Promise<void> {
  try {
    const rsp = await fetch(Endpoint.Health, {
      headers: {Accept: 'application/json'},
    })
    if (!rsp.ok) throw Error(`HTTP ${rsp.status}`)
    const health = (await rsp.json()) as HealthRsp
    status.textContent = health.username
      ? `Connected as u/${health.username}`
      : 'Connected'
  } catch (err) {
    status.textContent = `Not connected: ${err instanceof Error ? err.message : err}`
  }
}

void main()
