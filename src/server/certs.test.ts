import assert from 'node:assert/strict'
import {test} from 'node:test'
import {formatLength} from '../shared/api.ts'
import {
  type Cert,
  isValid,
  parseJson,
  parseLength,
  parseTable,
  postId,
  todayIST,
} from './certs.ts'

test('length: post format and MM.SS', () => {
  assert.equal(parseLength('2h 7s'), 7207)
  assert.equal(parseLength('2h 33m 2s'), 9182)
  assert.equal(parseLength('120.07'), 7207)
  assert.equal(parseLength('28s'), 28)
  assert.equal(parseLength(''), 0)
})

test('length: zero parts hidden', () => {
  assert.equal(formatLength(7207), '2h 7s')
  assert.equal(formatLength(9182), '2h 33m 2s')
  assert.equal(formatLength(7980), '2h 13m')
})

test('table: columns found by header, any order', () => {
  const md = `last updated at 2026-11-08T10:00:00+05:30

| Ref | When | Title | Length | Category | Language |
| - | - | - | - | - | - |
| TVM/1/45/2026 | 2026-11-08 | DRISHYAM 3 | 2h 33m 2s | UA 13+ | Malayalam |
| CHE/1/210/2026 | 2026-11-06 D2 | A \\| B \\[x\\] | 2h 7s | U | Tamil |`
  assert.deepEqual<Cert[]>(parseTable(md), [
    {
      category: 'UA 13+',
      date: '2026-11-08',
      language: 'Malayalam',
      ref: 'TVM/1/45/2026',
      secs: 9182,
      title: 'DRISHYAM 3',
    },
    {
      category: 'U',
      date: '2026-11-06',
      language: 'Tamil',
      ref: 'CHE/1/210/2026',
      secs: 7207,
      title: 'A | B [x]',
    },
  ])
})

test('table: missing column → nothing', () => {
  assert.deepEqual(parseTable('| Title | Language |\n| - | - |\n| X | Y |'), [])
})

test('json: same shape as the post', () => {
  const [c] = parseJson(
    '[{"ref":"CHE/1/210/2026","title":"ARIKOMBAN","language":"Tamil","category":"UA 13+","length":"2h 7s","date":"2026-11-08"}]',
  )
  assert.deepEqual(c, {
    category: 'UA 13+',
    date: '2026-11-08',
    language: 'Tamil',
    ref: 'CHE/1/210/2026',
    secs: 7207,
    title: 'ARIKOMBAN',
  })
})

test('json: clear errors', () => {
  assert.throws(() => parseJson('{oops'), /JSON|token|property/i)
  assert.throws(() => parseJson('{}'), /JSON list/)
  assert.throws(() => parseJson('[{"title":"X"}]'), /Item 1: "ref" missing/)
})

test('valid: films only, no future dates', () => {
  const c: Cert = {
    category: 'U',
    date: '2026-11-08',
    language: 'L',
    ref: 'R',
    secs: 3600,
    title: 'T',
  }
  assert.ok(isValid(c, '2026-11-08'))
  assert.ok(isValid({...c, secs: 28}, '2026-11-08')) // short items are kept too
  assert.ok(!isValid({...c, date: '2038-10-07'}, '2026-11-08'))
  assert.ok(!isValid({...c, date: 'soon'}, '2026-11-08'))
})

test('post id only', () => {
  assert.equal(
    postId(
      'https://www.reddit.com/r/kerala_boxoffice/comments/1abc2de/cbfc_tracker/',
    ),
    '',
  )
  assert.equal(postId('1abc2de'), 't3_1abc2de')
  assert.equal(postId('t3_1abc2de'), 't3_1abc2de')
  assert.equal(postId('not a post'), '')
})

test('today in IST', () => {
  assert.equal(todayIST(new Date('2026-11-07T19:00:00Z')), '2026-11-08')
})
