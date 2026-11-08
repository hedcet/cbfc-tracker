import {showToast} from '@devvit/web/client'
import {
  type CertRow,
  Endpoint,
  formatLength,
  type Keyword,
  keywordError,
  MAX_FOLLOW,
  type MeRsp,
  norm,
  PAGE,
  type SearchRsp,
  type WatchActRsp,
  type WatchReq,
} from '../shared/api.ts'

// Search and the watchlist both live on the server; this page only shows them.

const ICON = {
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  bellOn:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" fill="none"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  globe:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
}

/* ---------------- helpers ---------------- */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    c =>
      ({"'": '&#39;', '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;'})[
        c
      ] ?? c,
  )
const up = (k: string): string => k.toUpperCase()

/* ---------------- data ---------------- */
type Film = {
  ref: string
  date: string
  len: string
  lang: string
  title: string
  cat: string
}

let films: Film[] = [] // the search page on screen
let total = 0 // all matches of the search
let shownQ = '' // the search the films on screen belong to
let exact = false // a title equals the search
let hints: string[] = [] // random film names from the server: [search, watchlist]
let certsState: 'loading' | 'ready' | 'error' = 'loading'
let keywords: Keyword[] = [] // the viewer's watchlist, from the server
let busy = false // a watchlist change is on its way

let viewer = '' // username without u/; '' = logged out
let isMod = false

/* ---------------- rules ---------------- */
const page = {s: 0, w: 0}
const loggedIn = (): boolean => !!viewer
const find = (word: string): Keyword | undefined =>
  keywords.find(k => k.word === word)
const atLimit = (): boolean =>
  !isMod && keywords.filter(k => k.following).length >= MAX_FOLLOW

// quick checks before asking the server (which checks again)
function addError(k: string): string {
  const err = keywordError(k)
  if (err) return err
  if (find(k)?.following) return `Already following ${up(k)}`
  if (atLimit()) return `Limit: ${MAX_FOLLOW} keywords`
  return ''
}
function watchable(raw: string): string {
  const k = norm(raw)
  if (!loggedIn() || keywordError(k)) return ''
  if (k.length <= 2 && !exact) return ''
  return find(k)?.following ? '' : k
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
  // ( ‹ )  2 / 9  ( › )
  el.innerHTML = `<button class="icon round" type="button" title="Previous page" aria-label="Previous page" ${page[key] ? '' : 'disabled'}>${ICON.prev}</button><span aria-live="polite">${page[key] + 1} / ${pages}</span><button class="icon round" type="button" title="Next page" aria-label="Next page" ${page[key] < pages - 1 ? '' : 'disabled'}>${ICON.next}</button>`
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

function placeholders(): void {
  // a too-common word is not a valid keyword: fall back for the watchlist
  const watch =
    hints[1] && !keywordError(hints[1].toLowerCase()) ? hints[1] : ''
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
}

/* ---------------- watchlist ---------------- */
let wError = ''
function watchOrder(): Keyword[] {
  const mine = (k: Keyword): number =>
    k.following || k.owner === viewer ? 0 : 1
  // own first; then (non-mods) most followed; then newest added first
  return keywords
    .slice()
    .sort(
      (a, b) =>
        mine(a) - mine(b) ||
        (isMod || !mine(a) ? 0 : b.followers - a.followers) ||
        b.at - a.at,
    )
}
const jumpTo = (word: string): void => {
  const i = watchOrder().findIndex(k => k.word === word)
  if (i >= 0) page.w = Math.floor(i / PAGE)
}

function renderWatch(): void {
  const signed = loggedIn()
  const list = watchOrder()
  $<HTMLInputElement>('wInput').disabled = !signed
  $<HTMLButtonElement>('wAdd').disabled = !signed || busy

  const hidden = list.filter(k => !k.public).length
  const count = $('wCount')
  count.className = wError ? 'count err' : 'count'
  count.textContent =
    wError ||
    (list.length
      ? [
          `${list.length} keyword${list.length === 1 ? '' : 's'}`,
          signed ? `${list.filter(k => k.following).length} following` : '',
          isMod && hidden ? `${hidden} not public` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '')

  const start = pager('wPager', 'w', list.length, renderWatch)
  $('wList').innerHTML =
    list
      .slice(start, start + PAGE)
      .map(k => {
        const on = k.following
        const owner = k.owner === viewer
        const id = esc(k.word)
        const chip = k.fresh
          ? `<span class="chip" role="button" tabindex="0" title="Show matches" data-act="search-for" data-id="${id}">${k.fresh} new ›</span>`
          : ''
        // "u/kochi_fan + 2 followers" (owner + the others); "You + 2 followers" for your own
        const plural = (x: number): string =>
          `${x} follower${x === 1 ? '' : 's'}`
        const who = owner ? 'You' : isMod ? `u/${k.owner}` : ''
        const line2 = who
          ? k.followers > 1
            ? `${who} + ${plural(k.followers - 1)}`
            : who
          : plural(k.followers)
        const label = on ? 'Unfollow' : 'Follow'
        const off = !signed || busy ? 'disabled' : ''
        const acts = [
          `<button class="icon bell ${on ? 'on' : ''}" type="button" ${off} title="${signed ? label : 'Log in to follow'}" aria-label="${label}" aria-pressed="${on}" data-act="${on ? 'unfollow' : 'follow'}" data-id="${id}">${on ? ICON.bellOn : ICON.bell}</button>`,
        ]
        if (isMod) {
          const a = k.public ? 'Make private' : 'Make public'
          acts.push(
            `<button class="icon pub ${k.public ? 'on' : ''}" type="button" ${off} title="${a}" aria-label="${a}" aria-pressed="${k.public}" data-act="${k.public ? 'private' : 'public'}" data-id="${id}">${ICON.globe}</button>`,
          )
        }
        return `<div class="row"><div class="grow"><div class="l1">${esc(up(k.word))}${chip}</div><div class="l2">${esc(line2)}</div></div><div class="acts">${acts.join('')}</div></div>`
      })
      .join('') ||
    `<div class="empty">${signed ? 'No keywords yet' : 'Log in to follow'}</div>`
}

// one change on the server; the reply is the new list
async function change(act: WatchReq['act'], word: string): Promise<boolean> {
  if (busy) return false
  busy = true
  renderWatch()
  // deleted only when the last follower leaves
  const last = (find(word)?.followers ?? 0) <= 1
  let ok = false
  try {
    const rsp = await fetch(Endpoint.Watch, {
      body: JSON.stringify({act, word} satisfies WatchReq),
      headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
      method: 'POST',
    })
    const data = (await rsp.json()) as WatchActRsp
    if ('error' in data) showToast(data.error)
    else {
      keywords = data.keywords
      ok = true
      const done = {
        follow: `Following ${up(word)}`,
        private: `${up(word)} is private`,
        public: `${up(word)} is public`,
        unfollow: `${last ? 'Removed' : 'Unfollowed'} ${up(word)}`,
      }[act]
      showToast(done)
      if (act === 'follow') jumpTo(word)
    }
  } catch (err) {
    console.error(err)
    showToast('Couldn’t save, try again')
  }
  busy = false
  placeholders()
  renderWatch()
  renderSearch()
  return ok
}

async function addKeyword(raw: string): Promise<boolean> {
  const k = norm(raw)
  // "DRISHYAM 3" is two words: say so instead of following DRISHYAM3
  const err = /\s/.test(raw.trim()) ? 'One word only' : addError(k)
  if (err) {
    wError = err
    renderWatch()
    return false
  }
  wError = ''
  return change('follow', k)
}

/* ---------------- search + certificate sheet ---------------- */
// "12,377 films"
function totalLine(n: number): string {
  if (certsState === 'loading') return 'Loading…'
  if (certsState === 'error')
    return '<span class="err-text">Couldn’t load films</span> · <a role="button" tabindex="0" data-act="retry">Retry</a>'
  return n ? `${n.toLocaleString('en-IN')} films` : 'No films yet'
}

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
  const word = el.dataset.id ?? ''
  switch (el.dataset.act) {
    case 'follow':
      if (atLimit()) showToast(`Limit: ${MAX_FOLLOW} keywords`)
      else void change('follow', word)
      break
    case 'unfollow':
    case 'public':
    case 'private':
      void change(el.dataset.act, word)
      break
    case 'search-for':
      $<HTMLInputElement>('sInput').value = up(word)
      page.s = 0
      showTab('search')
      void loadSearch()
      break
    case 'retry':
      certsState = 'loading'
      renderSearch()
      void loadSearch()
      break
    case 'watch':
      void addKeyword($<HTMLInputElement>('sInput').value)
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
$('wAdd').onclick = async () => {
  const input = $<HTMLInputElement>('wInput')
  if (await addKeyword(input.value)) input.value = ''
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
    viewer = me.username ?? ''
    isMod = me.isMod
  } catch (err) {
    console.error(err)
  }
}

const toFilm = ([ref, title, lang, cat, secs, date]: CertRow): Film => ({
  cat,
  date,
  lang,
  len: formatLength(secs),
  ref,
  title,
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

// the viewer's watchlist (with "N new" per followed keyword)
async function loadWatch(): Promise<void> {
  try {
    const rsp = await fetch(Endpoint.Watch, {
      body: '{}',
      headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
      method: 'POST',
    })
    const data = (await rsp.json()) as WatchActRsp
    if ('keywords' in data) keywords = data.keywords
  } catch (err) {
    console.error(err)
  }
}

const watchTab = document.querySelector('[data-tab="watch"]')
const searchTab = document.querySelector('[data-tab="search"]')
if (watchTab) watchTab.innerHTML = `${ICON.star}Watchlist`
if (searchTab) searchTab.innerHTML = `${ICON.search}Search`
$('wAdd').innerHTML = `${ICON.plus}Add`
$('sheetClose').innerHTML = ICON.close
$('sClear').innerHTML = ICON.close
placeholders()
renderWatch()
renderSearch()
void Promise.all([loadMe(), loadSearch(), loadWatch()]).then(() => {
  placeholders()
  renderWatch()
  renderSearch()
})
