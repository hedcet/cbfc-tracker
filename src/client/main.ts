import {type CertsRsp, Endpoint, type MeRsp} from '../shared/api.ts'

// Search uses the real certificates stored by the server (source post + initial data).
// The watchlist still runs on demo keywords in the browser; v3 moves it to the server.

/* ---------------- settings ---------------- */
const PAGE = 6 // rows per page: fits the tall post
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
const norm = (t: string): string => t.toLowerCase().replace(/[^0-9a-z]+/g, '')
const up = (k: string): string => k.toUpperCase()

// dates are IST, like CBFC
const today = new Date().toLocaleDateString('en-CA', {
  timeZone: 'Asia/Kolkata',
})
const when = (d: string): string => {
  const k = Math.round((Date.parse(today) - Date.parse(d)) / 864e5)
  return k > 0 ? `${d} D${k}` : d
}
const minutes = (len: string): number => {
  const h = /(\d+)h/.exec(len)
  const m = /(\d+)m(?!s)/.exec(len)
  return (h ? 60 * Number(h[1]) : 0) + (m ? Number(m[1]) : 0)
}

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

let films: Film[] = []
let certsState: 'loading' | 'ready' | 'error' = 'loading'

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
const isFilm = (f: Film): boolean => minutes(f.len) >= 60
const newest = (list: Film[]): Film[] =>
  list.slice().sort((a, b) => b.date.localeCompare(a.date) || b.seen - a.seen)
const contains = (title: string, q: string): boolean => norm(title).includes(q)
// 2 letters = whole title only; 3+ = contains
const kwMatch = (title: string, k: string): boolean =>
  k.length <= 2 ? norm(title) === k : contains(title, k)
const newCount = (k: Keyword): number => {
  const since = k.subs[viewer]
  if (since === undefined) return 0
  return films.filter(
    f => isFilm(f) && f.seen > since && kwMatch(f.title, k.keyword),
  ).length
}

function keywordError(k: string): string {
  if (!KEYWORD.test(k))
    return /\s/.test(k) ? 'One word only' : 'Letters and numbers only (2–20)'
  if (STOP.has(k)) return 'Too common, try another word'
  const same = keywords.find(x => x.keyword === k)
  if (same && follows(same)) return `Already following ${up(k)}`
  if (atLimit()) return `You can follow ${MAX_FOLLOW} for now`
  return ''
}
function watchable(raw: string): string {
  const k = norm(raw)
  if (!loggedIn() || !KEYWORD.test(k) || STOP.has(k)) return ''
  if (k.length <= 2 && !films.some(f => isFilm(f) && norm(f.title) === k))
    return ''
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

let toastTimer: ReturnType<typeof setTimeout> | undefined
let undoFn: (() => void) | null = null
function toast(msg: string, undo?: () => void): void {
  $('toastMsg').textContent = msg
  undoFn = undo ?? null
  $('toastUndo').hidden = !undo
  $('toast').classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    $('toast').classList.remove('on')
    undoFn = null
  }, 4000)
}
$('toastUndo').onclick = () => {
  const fn = undoFn
  undoFn = null
  $('toast').classList.remove('on')
  fn?.()
}

function placeholders(): void {
  const names = films
    .filter(f => isFilm(f) && /^[A-Z0-9]{5,14}$/.test(f.title))
    .map(f => f.title)
  const pick = (): string =>
    names[Math.floor(Math.random() * names.length)] ?? 'DRISHYAM'
  $<HTMLInputElement>('wInput').placeholder = loggedIn()
    ? `Film name, like ${pick()}`
    : 'Log in to add'
  $<HTMLInputElement>('sInput').placeholder = `Search films, like ${pick()}`
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
          signed ? `${list.filter(follows).length} you follow` : '',
          isMod && toApprove ? `${toApprove} to approve` : '',
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
          ? `<span class="chip" title="Show matches" data-act="search-for" data-id="${k.id}">${n} new ›</span>`
          : ''
        const line2 = `${followerCount(k)} following${owner ? ' · yours' : isMod ? ` · added by ${k.owner}` : ''}`
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
    toast(isMod ? `Added ${up(k)}` : `Added ${up(k)} · in review`)
  }
  wError = ''
  jumpTo(item)
  placeholders()
  renderWatch()
  renderSearch()
  return true
}

function follow(k: Keyword): void {
  if (follows(k)) {
    leave(k)
    return
  }
  if (atLimit()) {
    toast(`You can follow ${MAX_FOLLOW} for now`)
    return
  }
  k.subs[viewer] = clock
  toast(`Following ${up(k.keyword)}`)
  jumpTo(k)
  renderWatch()
  renderSearch()
}

// stop following; ownership passes to the earliest follower; deleted only when nobody follows
function leave(k: Keyword): void {
  const before = {owner: k.owner, subs: {...k.subs}}
  const index = keywords.indexOf(k)
  const wasOwner = k.owner === viewer
  delete k.subs[viewer]
  const left = Object.entries(k.subs).sort((a, b) => a[1] - b[1])
  const first = left[0]
  if (!first) keywords.splice(index, 1)
  else if (wasOwner) k.owner = first[0]
  toast(`${wasOwner ? 'Removed' : 'Unfollowed'} ${up(k.keyword)}`, () => {
    if (atLimit()) return toast(`You can follow ${MAX_FOLLOW} for now`)
    Object.assign(k, before)
    if (!keywords.includes(k)) keywords.splice(index, 0, k)
    renderWatch()
    renderSearch()
  })
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
  const all = films.filter(isFilm)
  const list = newest(q ? all.filter(f => contains(f.title, q)) : all)
  $('sClear').hidden = !raw

  const word = watchable(raw)
  $('sCount').innerHTML = !q
    ? totalLine(all.length)
    : list.length
      ? `${list.length} match${list.length === 1 ? '' : 'es'}${word ? ` · <a data-act="watch">Watch ${esc(up(word))}</a>` : ''}`
      : ''

  const start = pager('sPager', 's', list.length, renderSearch)
  $('sList').innerHTML =
    list
      .slice(start, start + PAGE)
      .map(
        f =>
          `<div class="row click" tabindex="0" data-act="sheet" data-ref="${esc(f.ref)}"><div class="grow"><div class="l1">${esc(f.title)}</div><div class="l2">${esc(`${f.lang} · ${f.cat} · ${f.len}`)}</div></div><span class="chev">›</span></div>`,
      )
      .join('') ||
    (!q
      ? ''
      : `<div class="empty">Not certified yet${word ? `<br><button class="btn sm" type="button" data-act="watch">Watch ${esc(up(word))}</button>` : ''}</div>`)
}

// "12,377 films"
function totalLine(n: number): string {
  if (certsState === 'loading') return 'Loading…'
  if (certsState === 'error')
    return '<span class="err-text">Couldn’t load films</span>'
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
    `<div class="grid c2">${field('Certificate no.', c.ref)}${field('When', when(c.date))}</div>`
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
        renderSearch()
      }
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
  if (ev.key === 'Enter' && el.dataset.act === 'sheet' && el.dataset.ref)
    openSheet(el.dataset.ref, el)
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
$('sInput').oninput = () => {
  page.s = 0
  renderSearch()
}
$('sClear').onclick = () => {
  $<HTMLInputElement>('sInput').value = ''
  page.s = 0
  renderSearch()
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

async function loadCerts(): Promise<void> {
  try {
    const rsp = await fetch(Endpoint.Certs, {
      headers: {Accept: 'application/json'},
    })
    if (!rsp.ok) throw new Error(`certs ${rsp.status}`)
    const data = (await rsp.json()) as CertsRsp
    films = data.certs.map(([ref, title, lang, cat, secs, date, seq]) => ({
      ref,
      title,
      lang,
      cat,
      len: formatLength(secs),
      date,
      seen: seq,
    }))
    clock = films.reduce((m, f) => Math.max(m, f.seen), 0)
    certsState = 'ready'
  } catch (err) {
    console.error(err)
    certsState = 'error'
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
void Promise.all([loadMe(), loadCerts()]).then(() => {
  demoFollows()
  placeholders()
  renderWatch()
  renderSearch()
})
