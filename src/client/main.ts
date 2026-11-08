import {showToast} from '@devvit/web/client'
import {
  type CertRow,
  Endpoint,
  type MeRsp,
  type NewRsp,
  norm,
  PAGE,
  type SearchRsp,
} from '../shared/api.ts'

// Search asks the server for one page at a time (source post + initial data).
// The watchlist still runs on demo keywords in the browser; v3 moves it to the server.

/* ---------------- settings ---------------- */
const MAX_FOLLOW = 3 // v1 follow limit per user (mods: no limit)
const KEYWORD = /^[a-z0-9]{2,20}$/ // one word; the longest word in any title is 18
const STOP = new Set(
  'the of and a an in on to is it my i me we you he she his her love man life story part movie film'.split(
    ' ',
  ),
)

const ICON = {
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  bellOn:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" fill="none"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
}

/* ---------------- helpers ---------------- */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    c =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        c
      ] ?? c,
  )
const up = (k: string): string => k.toUpperCase()

const formatLength = (secs: number): string =>
  (
    [
      [Math.floor(secs / 3600), 'h'],
      [Math.floor(secs / 60) % 60, 'm'],
      [secs % 60, 's'],
    ] as [number, string][]
  )
    .filter(([n]) => n)
    .map(([n, u]) => `${n}${u}`)
    .join(' ')

/* ---------------- data ---------------- */
type Film = {
  ref: string
  date: string
  len: string
  lang: string
  title: string
  cat: string
  seen: number
}
type Keyword = {
  id: number
  keyword: string
  owner: string
  subs: Record<string, number>
  approved: boolean
  addedAt: number
}

let films: Film[] = [] // the search page on screen
let total = 0 // all matches of the search
let shownQ = '' // the search the films on screen belong to
let exact = false // a title equals the search
let hints: string[] = [] // random film names from the server: [search, watchlist]
let certsState: 'loading' | 'ready' | 'error' = 'loading'
let newCounts: Record<number, number> = {} // keyword id → new since follow

let viewer = '' // set from the server; '' = logged out
let isMod = false
let nextId = 0
const kw = (
  keyword: string,
  owner: string,
  subs: Record<string, number>,
  approved: boolean,
): Keyword => ({
  id: ++nextId,
  keyword,
  owner,
  subs,
  approved,
  addedAt: nextId,
})
const keywords: Keyword[] = [
  kw('arikomban', 'u/a1', {'u/a1': 0}, true),
  kw('drishyam', 'u/kochi_fan', {'u/kochi_fan': 0, 'u/mollywood_man': 0}, true),
  kw('coolie', 'u/thalaivar', {'u/thalaivar': 50}, true),
  kw('toxic', 'u/rocky', {'u/rocky': 50}, true),
  kw('kantara', 'u/rishab_fan', {'u/rishab_fan': 50}, true),
  kw('ramayana', 'u/b1', {'u/b1': 50}, true),
  kw('empuraan', 'u/lal_ettan', {'u/lal_ettan': 50}, true),
  kw('blah', 'u/troll42', {'u/troll42': 50}, false),
]
let clock = 0 // newest certificate seq; "N new" counts what came after a follow

/* ---------------- rules ---------------- */
const page = {w: 0, s: 0}
const loggedIn = (): boolean => !!viewer
const follows = (k: Keyword): boolean => viewer in k.subs
const followerCount = (k: Keyword): number => Object.keys(k.subs).length
const atLimit = (): boolean =>
  !isMod && keywords.filter(follows).length >= MAX_FOLLOW
const newCount = (k: Keyword): number =>
  follows(k) ? (newCounts[k.id] ?? 0) : 0

function keywordError(k: string): string {
  if (!KEYWORD.test(k))
    return /\s/.test(k) ? 'One word only' : '2–20 letters or digits'
  if (STOP.has(k)) return 'Too common, try another'
  const same = keywords.find(x => x.keyword === k)
  if (same && follows(same)) return `Already following ${up(k)}`
  if (atLimit()) return `Limit: ${MAX_FOLLOW} keywords`
  return ''
}
function watchable(raw: string): string {
  const k = norm(raw)
  if (!loggedIn() || !KEYWORD.test(k) || STOP.has(k)) return ''
  if (k.length <= 2 && !exact) return ''
  const same = keywords.find(x => x.keyword === k)
  return same && follows(same) ? '' : k
}

/* ---------------- shared UI ---------------- */
function pager(
  id: string,
  key: 'w' | 's',
  total: number,
  rerender: () => void,
): number {
  const pages = Math.max(1, Math.ceil(total / PAGE))
  page[key] = Math.min(page[key], pages - 1)
  const el = $(id)
  el.style.visibility = pages > 1 ? 'visible' : 'hidden'
  el.innerHTML = `<button class="btn sm" type="button" ${page[key] ? '' : 'disabled'}>‹ Prev</button><span>Page ${page[key] + 1} of ${pages}</span><button class="btn sm" type="button" ${page[key] < pages - 1 ? '' : 'disabled'}>Next ›</button>`
  ;(el.firstElementChild as HTMLButtonElement).onclick = () => {
    page[key]--
    rerender()
  }
  ;(el.lastElementChild as HTMLButtonElement).onclick = () => {
    page[key]++
    rerender()
  }
  return page[key] * PAGE
}

// Reddit's own toast
const toast = (msg: string): void => showToast(msg)

function placeholders(): void {
  // a too-common word is not a valid keyword: fall back for the watchlist
  const watch = hints[1] && !STOP.has(hints[1].toLowerCase()) ? hints[1] : ''
  $<HTMLInputElement>('wInput').placeholder = loggedIn()
    ? `Film name, like ${watch || 'DRISHYAM'}`
    : 'Log in to add'
  $<HTMLInputElement>('sInput').placeholder =
    `Search films, like ${hints[0] || 'DRISHYAM'}`
}

function showTab(t: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    '.tabs button',
  )) {
    const on = b.dataset.tab === t
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', String(on))
  }
  for (const p of document.querySelectorAll('.pane'))
    p.classList.toggle('on', p.id === t)
  $('demo').hidden = t !== 'watch' // only the watchlist is demo data now
}

/* ---------------- watchlist ---------------- */
let wError = ''
const visible = (k: Keyword): boolean => k.approved || isMod || follows(k)
function watchOrder(): Keyword[] {
  const mine = (k: Keyword): number =>
    follows(k) || k.owner === viewer ? 0 : 1
  // mods: every keyword; their own first, then newest added first
  if (isMod)
    return keywords
      .slice()
      .sort((a, b) => mine(a) - mine(b) || b.addedAt - a.addedAt)
  return keywords
    .filter(visible)
    .sort(
      (a, b) =>
        mine(a) - mine(b) ||
        (mine(a) ? followerCount(b) - followerCount(a) : 0) ||
        b.addedAt - a.addedAt,
    )
}
const jumpTo = (k: Keyword): void => {
  const i = watchOrder().indexOf(k)
  if (i >= 0) page.w = Math.floor(i / PAGE)
}

function renderWatch(): void {
  const signed = loggedIn()
  const list = watchOrder()
  $<HTMLInputElement>('wInput').disabled = !signed
  $<HTMLButtonElement>('wAdd').disabled = !signed

  const toApprove = list.filter(k => !k.approved).length
  const count = $('wCount')
  count.className = wError ? 'count err' : 'count'
  count.textContent =
    wError ||
    (list.length
      ? [
          `${list.length} keyword${list.length === 1 ? '' : 's'}`,
          signed ? `${list.filter(follows).length} following` : '',
          isMod && toApprove ? `${toApprove} pending` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '')

  const start = pager('wPager', 'w', list.length, renderWatch)
  $('wList').innerHTML =
    list
      .slice(start, start + PAGE)
      .map(k => {
        const on = follows(k)
        const n = newCount(k)
        const owner = k.owner === viewer
        const chip = n
          ? `<span class="chip" role="button" tabindex="0" title="Show matches" data-act="search-for" data-id="${k.id}">${n} new ›</span>`
          : ''
        const line2 = `${followerCount(k)} follower${followerCount(k) === 1 ? '' : 's'}${owner ? ' · yours' : isMod ? ` · ${k.owner}` : ''}`
        const label = on ? 'Unfollow' : 'Follow'
        const acts = [
          `<button class="icon bell ${on ? 'on' : ''}" type="button" ${signed ? '' : 'disabled'} title="${signed ? label : 'Log in to follow'}" aria-label="${label}" aria-pressed="${on}" data-act="follow" data-id="${k.id}">${on ? ICON.bellOn : ICON.bell}</button>`,
        ]
        if (owner)
          acts.push(
            `<button class="icon del" type="button" title="Remove" aria-label="Remove" data-act="leave" data-id="${k.id}">${ICON.trash}</button>`,
          )
        if (isMod) {
          const a = k.approved ? 'Unapprove' : 'Approve'
          acts.push(
            `<button class="icon ok ${k.approved ? 'on' : ''}" type="button" title="${a}" aria-label="${a}" aria-pressed="${k.approved}" data-act="approve" data-id="${k.id}">${ICON.check}</button>`,
          )
        }
        return `<div class="row"><div class="grow"><div class="l1">${esc(up(k.keyword))}${chip}</div><div class="l2">${esc(line2)}</div></div><div class="acts">${acts.join('')}</div></div>`
      })
      .join('') ||
    `<div class="empty">${signed ? 'No keywords yet' : 'Log in to follow'}</div>`
}

const byId = (id: number): Keyword | undefined =>
  keywords.find(k => k.id === id)

function addKeyword(raw: string): boolean {
  const k = raw.trim().toLowerCase()
  const err = keywordError(k)
  if (err) {
    wError = err
    renderWatch()
    return false
  }
  let item = keywords.find(x => x.keyword === k)
  if (item) {
    item.subs[viewer] = clock
    toast(`Following ${up(k)}`)
  } else {
    item = kw(k, viewer, {[viewer]: clock}, isMod)
    keywords.push(item)
    toast(`Added ${up(k)}`)
  }
  wError = ''
  jumpTo(item)
  placeholders()
  renderWatch()
  renderSearch()
  void loadNew()
  return true
}

function follow(k: Keyword): void {
  if (follows(k)) {
    leave(k)
    return
  }
  if (atLimit()) {
    toast(`Limit: ${MAX_FOLLOW} keywords`)
    return
  }
  k.subs[viewer] = clock
  toast(`Following ${up(k.keyword)}`)
  jumpTo(k)
  renderWatch()
  renderSearch()
  void loadNew()
}

// stop following; ownership passes to the earliest follower; deleted only when nobody follows
function leave(k: Keyword): void {
  const index = keywords.indexOf(k)
  const wasOwner = k.owner === viewer
  delete k.subs[viewer]
  const left = Object.entries(k.subs).sort((a, b) => a[1] - b[1])
  const first = left[0]
  if (!first) keywords.splice(index, 1)
  else if (wasOwner) k.owner = first[0]
  // "Removed" only when it is really gone; otherwise it stays with the others
  toast(`${first ? 'Unfollowed' : 'Removed'} ${up(k.keyword)}`)
  renderWatch()
  renderSearch()
}

function approve(k: Keyword): void {
  k.approved = !k.approved
  toast(`${up(k.keyword)} ${k.approved ? 'approved' : 'unapproved'}`)
  renderWatch()
}

/* ---------------- search + certificate sheet ---------------- */
function renderSearch(): void {
  const input = $<HTMLInputElement>('sInput')
  const raw = input.value
  const q = norm(raw)
  $('sClear').hidden = !raw

  const word = watchable(raw)
  $('sCount').innerHTML =
    certsState === 'ready' && q !== shownQ
      ? 'Searching…' // the answer for the new text is on its way
      : !q || certsState !== 'ready'
        ? totalLine(total)
        : total
          ? `${total} match${total === 1 ? '' : 'es'}${word ? ` · <a role="button" tabindex="0" data-act="watch">Watch ${esc(up(word))}</a>` : ''}`
          : ''

  pager('sPager', 's', total, () => void loadSearch())
  $('sList').innerHTML =
    films
      .map(
        f =>
          `<div class="row click" role="button" tabindex="0" data-act="sheet" data-ref="${esc(f.ref)}"><div class="grow"><div class="l1">${esc(f.title)}</div><div class="l2">${esc(`${f.lang} · ${f.cat} · ${f.len}`)}</div></div><span class="chev">›</span></div>`,
      )
      .join('') ||
    (!q
      ? ''
      : `<div class="empty">No matches${word ? `<br><button class="btn sm" type="button" data-act="watch">Watch ${esc(up(word))}</button>` : ''}</div>`)
}

// "12,377 films"
function totalLine(n: number): string {
  if (certsState === 'loading') return 'Loading…'
  if (certsState === 'error')
    return '<span class="err-text">Couldn’t load films</span> · <a role="button" tabindex="0" data-act="retry">Retry</a>'
  return n ? `${n.toLocaleString('en-IN')} films` : 'No films yet'
}

let sheetOpen = false
let lastFocus: HTMLElement | null = null
function openSheet(ref: string, row: HTMLElement): void {
  const c = films.find(f => f.ref === ref)
  if (!c) return
  const field = (k: string, v: string, cls = ''): string =>
    `<div class="kv ${cls}"><span>${k}</span><b>${esc(v)}</b></div>`
  $('sheetBody').innerHTML =
    field('Title', c.title, 'title') +
    `<div class="grid c3">${field('Language', c.lang)}${field('Category', c.cat)}${field('Length', c.len)}</div>` +
    `<div class="grid c2">${field('Certificate no.', c.ref)}${field('When', c.date)}</div>`
  sheetOpen = true
  lastFocus = row
  $('sheetBg').classList.add('on')
  $('sheetClose').focus()
}
function closeSheet(): void {
  if (!sheetOpen) return
  sheetOpen = false
  $('sheetBg').classList.remove('on')
  lastFocus?.focus()
}

/* ---------------- events (one delegated listener; no inline handlers) ---------------- */
document.addEventListener('click', ev => {
  const target = ev.target as HTMLElement
  if (target.id === 'sheetBg') return closeSheet()
  const tab = target.closest<HTMLElement>('[data-tab]')
  if (tab?.dataset.tab) return showTab(tab.dataset.tab)
  const el = target.closest<HTMLElement>('[data-act]')
  if (!el) return
  const k = byId(Number(el.dataset.id))
  switch (el.dataset.act) {
    case 'follow':
      if (k) follow(k)
      break
    case 'leave':
      if (k) leave(k)
      break
    case 'approve':
      if (k) approve(k)
      break
    case 'search-for':
      if (k) {
        $<HTMLInputElement>('sInput').value = up(k.keyword)
        page.s = 0
        showTab('search')
        void loadSearch()
      }
      break
    case 'retry':
      certsState = 'loading'
      renderSearch()
      void loadSearch()
      break
    case 'watch':
      addKeyword(norm($<HTMLInputElement>('sInput').value))
      showTab('watch')
      break
    case 'sheet':
      if (el.dataset.ref) openSheet(el.dataset.ref, el)
      break
  }
})
document.addEventListener('keydown', ev => {
  const el = ev.target as HTMLElement
  // rows, links and chips act like buttons: Enter or Space
  if (
    (ev.key === 'Enter' || ev.key === ' ') &&
    el.getAttribute('role') === 'button' &&
    el.dataset.act
  ) {
    ev.preventDefault()
    el.click()
  }
  if (!sheetOpen) return
  if (ev.key === 'Escape') closeSheet()
  if (ev.key === 'Tab') {
    ev.preventDefault()
    $('sheetClose').focus()
  }
})
$('sheetClose').onclick = closeSheet
$('wAdd').onclick = () => {
  const input = $<HTMLInputElement>('wInput')
  if (addKeyword(input.value)) input.value = ''
}
$('wInput').onkeydown = ev => {
  if (ev.key === 'Enter') $('wAdd').click()
}
$('wInput').oninput = () => {
  if (wError) {
    wError = ''
    renderWatch()
  }
}
let typing: ReturnType<typeof setTimeout> | undefined
$('sInput').oninput = () => {
  page.s = 0
  renderSearch()
  clearTimeout(typing)
  typing = setTimeout(() => void loadSearch(), 250) // ask once typing pauses
}
$('sClear').onclick = () => {
  $<HTMLInputElement>('sInput').value = ''
  page.s = 0
  void loadSearch()
  $('sInput').focus()
}

/* ---------------- start ---------------- */
async function loadMe(): Promise<void> {
  try {
    const rsp = await fetch(Endpoint.Me, {
      headers: {Accept: 'application/json'},
    })
    if (!rsp.ok) return
    const me = (await rsp.json()) as MeRsp
    viewer = me.username ? `u/${me.username}` : ''
    isMod = me.isMod
  } catch (err) {
    console.error(err)
  }
}

const toFilm = ([ref, title, lang, cat, secs, date, seq]: CertRow): Film => ({
  ref,
  title,
  lang,
  cat,
  len: formatLength(secs),
  date,
  seen: seq,
})

// one page of the search; an older answer that comes back late is ignored
let asked = 0
async function loadSearch(): Promise<void> {
  const mine = ++asked
  const q = norm($<HTMLInputElement>('sInput').value)
  try {
    const rsp = await fetch(
      `${Endpoint.Search}?q=${encodeURIComponent(q)}&page=${page.s}`,
      {headers: {Accept: 'application/json'}},
    )
    if (!rsp.ok) throw new Error(`search ${rsp.status}`)
    const data = (await rsp.json()) as SearchRsp
    if (mine !== asked) return
    films = data.certs.map(toFilm)
    shownQ = q
    total = data.total
    exact = data.exact
    clock = data.clock
    hints = data.hints
    placeholders()
    certsState = 'ready'
  } catch (err) {
    console.error(err)
    if (mine !== asked) return
    certsState = 'error'
  }
  renderSearch()
}

// "N new" for the keywords the viewer follows
async function loadNew(): Promise<void> {
  const mine = keywords.filter(follows)
  if (!mine.length) return
  try {
    const k = mine.map(x => `${x.keyword}:${x.subs[viewer]}`).join(',')
    const rsp = await fetch(`${Endpoint.New}?k=${encodeURIComponent(k)}`, {
      headers: {Accept: 'application/json'},
    })
    if (!rsp.ok) throw new Error(`new ${rsp.status}`)
    const data = (await rsp.json()) as NewRsp
    newCounts = Object.fromEntries(
      mine.map((x, i) => [x.id, data.counts[i] ?? 0]),
    )
    renderWatch()
  } catch (err) {
    console.error(err)
  }
}

// demo watchlist: follows start a little before the newest certificate,
// and the viewer follows DRISHYAM, so "N new" chips have something to show
function demoFollows(): void {
  for (const k of keywords)
    for (const u of Object.keys(k.subs)) k.subs[u] = Math.max(0, clock - 300)
  const demo = keywords.find(k => k.keyword === 'drishyam')
  if (viewer && demo) demo.subs[viewer] = Math.max(0, clock - 300)
}

const watchTab = document.querySelector('[data-tab="watch"]')
const searchTab = document.querySelector('[data-tab="search"]')
if (watchTab) watchTab.innerHTML = `${ICON.star}Watchlist`
if (searchTab) searchTab.innerHTML = `${ICON.search}Search`
$('sheetClose').innerHTML = ICON.close
$('sClear').innerHTML = ICON.close
$('demo').hidden = true
placeholders()
renderWatch()
renderSearch()
void Promise.all([loadMe(), loadSearch()]).then(() => {
  demoFollows()
  placeholders()
  renderWatch()
  renderSearch()
  void loadNew()
})
