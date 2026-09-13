import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MAX_SELECTED,
  isSkillName,
  validateSelection,
  escapePromptBraces,
  buildInjectionMessage,
  classifySelection,
  applyBodies,
  cachedSuffix,
} from '../lib/helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'sample-skill.json'), 'utf8'))

test('isSkillName accepts kebab-case and rejects others', () => {
  assert.equal(isSkillName('caveman'), true)
  assert.equal(isSkillName('deep-caveman'), true)
  assert.equal(isSkillName('Caveman'), false)
  assert.equal(isSkillName('caveman_ponytail'), false)
  assert.equal(isSkillName(''), false)
})

test('validateSelection accepts a valid config', () => {
  const r = validateSelection({ mode: 'each-prompt', selected: ['caveman', 'ponytail'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.config, { mode: 'each-prompt', selected: ['caveman', 'ponytail'] })
})

test('validateSelection rejects bad mode', () => {
  const r = validateSelection({ mode: 'sometimes', selected: [] })
  assert.equal(r.ok, false)
  assert.match(r.error, /mode/)
})

test('validateSelection rejects non-kebab skill names', () => {
  const r = validateSelection({ mode: 'start-only', selected: ['Caveman'] })
  assert.equal(r.ok, false)
  assert.match(r.error, /kebab/)
})

test('validateSelection dedupes and rejects over cap', () => {
  const dup = validateSelection({ mode: 'each-prompt', selected: ['caveman', 'caveman'] })
  assert.equal(dup.ok, true)
  assert.deepEqual(dup.config.selected, ['caveman'])
  const many = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => 'skill-' + i)
  const over = validateSelection({ mode: 'each-prompt', selected: many })
  assert.equal(over.ok, false)
  assert.match(over.error, /16/)
})

test('validateSelection cap applies after dedupe', () => {
  const many = Array.from({ length: MAX_SELECTED }, (_, i) => 'skill-' + i)
  const withDup = [...many, 'skill-0']
  const r = validateSelection({ mode: 'each-prompt', selected: withDup })
  assert.equal(r.ok, true)
  assert.equal(r.config.selected.length, MAX_SELECTED)
})

test('validateSelection accepts empty selection', () => {
  const r = validateSelection({ mode: 'each-prompt', selected: [] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.config, { mode: 'each-prompt', selected: [] })
})

test('validateSelection rejects missing mode', () => {
  const r = validateSelection({ selected: ['caveman'] })
  assert.equal(r.ok, false)
})

test('validateSelection rejects non-string entries', () => {
  const r = validateSelection({ mode: 'each-prompt', selected: [42] })
  assert.equal(r.ok, false)
})

test('validateSelection rejects array input', () => {
  assert.equal(validateSelection([]).ok, false)
})

test('validateSelection rejects non-object input', () => {
  assert.equal(validateSelection(null).ok, false)
  assert.equal(validateSelection('nope').ok, false)
  assert.equal(validateSelection(undefined).ok, false)
})

test('escapePromptBraces escapes double open braces only', () => {
  assert.equal(escapePromptBraces('use {{model}} here'), 'use &#123;&#123;model}} here')
  assert.equal(escapePromptBraces('no braces'), 'no braces')
  assert.equal(escapePromptBraces('{{a}} and {{b}}'), '&#123;&#123;a}} and &#123;&#123;b}}')
})

test('buildInjectionMessage returns the skill-invocation user-message shape', () => {
  const msg = buildInjectionMessage('caveman', '<skill_content name="caveman">body</skill_content>')
  assert.deepEqual(msg, {
    content: [{ type: 'text', text: '<skill_content name="caveman">body</skill_content>' }],
    source: { kind: 'skill-invocation', name: 'caveman', form: 'instructions' },
  })
})

test('buildInjectionMessage accepts a fixture-derived rendered block', () => {
  const rendered = '<skill_content name="' + fixture.name + '">' + fixture.content + '</skill_content>'
  const msg = buildInjectionMessage(fixture.name, rendered)
  assert.equal(msg.source.name, 'caveman')
  assert.equal(msg.content[0].text, rendered)
})

test('classifySelection maps ready, unknown, load-failed in selection order', () => {
  const rows = classifySelection({
    selected: ['alpha', 'ghost', 'beta'],
    catalog: { kind: 'scoped', names: ['alpha', 'beta'], complete: true },
    scoped: true,
    loads: new Map([
      ['alpha', { ok: true }],
      ['beta', { ok: false, reason: 'EACCES' }],
    ]),
  })
  assert.deepEqual(rows, [
    { name: 'alpha', state: 'ready' },
    { name: 'ghost', state: 'unknown', reason: 'not in the skill catalog' },
    { name: 'beta', state: 'load-failed', reason: 'EACCES' },
  ])
})

test('classifySelection gives an advertised name a default load-failed reason', () => {
  const rows = classifySelection({
    selected: ['alpha'],
    catalog: { kind: 'scoped', names: ['alpha'], complete: true },
    scoped: true,
    loads: new Map([['alpha', { ok: false }]]),
  })
  assert.deepEqual(rows, [
    { name: 'alpha', state: 'load-failed', reason: 'skill body could not be loaded' },
  ])
})

test('classifySelection never calls an incomplete catalog unknown', () => {
  const rows = classifySelection({
    selected: ['ghost'],
    catalog: { kind: 'scoped', names: [], complete: false },
    scoped: true,
    loads: new Map(),
  })
  assert.equal(rows[0].state, 'unavailable')
  assert.equal(rows[0].reason, 'provider discovery incomplete')
})

test('classifySelection never calls an unscoped absence unknown', () => {
  const rows = classifySelection({
    selected: ['ghost'],
    catalog: { kind: 'scoped', names: [], complete: true },
    scoped: false,
    loads: new Map(),
  })
  assert.equal(rows[0].state, 'no-scope')
  assert.equal(rows[0].reason, 'waiting for a session to establish scope')
})

test('classifySelection reports a catalog read failure as unavailable', () => {
  const rows = classifySelection({
    selected: ['alpha'],
    catalog: { kind: 'error', reason: 'boom' },
    scoped: true,
    loads: new Map(),
  })
  assert.deepEqual(rows, [{ name: 'alpha', state: 'unavailable', reason: 'boom' }])
})

test('classifySelection keeps an advertised name resolvable even when discovery is incomplete', () => {
  const rows = classifySelection({
    selected: ['alpha'],
    catalog: { kind: 'scoped', names: ['alpha'], complete: false },
    scoped: true,
    loads: new Map([['alpha', { ok: true }]]),
  })
  assert.deepEqual(rows, [{ name: 'alpha', state: 'ready' }])
})

test('classifySelection returns one row per selected name', () => {
  const rows = classifySelection({
    selected: ['beta', 'alpha', 'gamma'],
    catalog: { kind: 'scoped', names: ['alpha', 'beta'], complete: true },
    scoped: true,
    loads: new Map([
      ['alpha', { ok: true }],
      ['beta', { ok: true }],
    ]),
  })
  assert.deepEqual(rows.map((r) => r.name), ['beta', 'alpha', 'gamma'])
})

test('classifySelection on an empty selection makes no rows', () => {
  const rows = classifySelection({
    selected: [],
    catalog: { kind: 'scoped', names: [], complete: true },
    scoped: true,
    loads: new Map(),
  })
  assert.deepEqual(rows, [])
})

test('applyBodies replaces on ready, keeps last-good on transient, drops unknown', () => {
  const prev = new Map([
    ['alpha', 'old-alpha'],
    ['beta', 'old-beta'],
    ['ghost', 'old-ghost'],
  ])
  const fresh = new Map([['alpha', 'new-alpha']])
  const next = applyBodies(
    prev,
    [
      { name: 'alpha', state: 'ready' },
      { name: 'beta', state: 'unavailable', reason: 'provider discovery incomplete' },
      { name: 'ghost', state: 'unknown', reason: 'not in the skill catalog' },
    ],
    fresh,
  )
  assert.deepEqual([...next], [
    ['alpha', 'new-alpha'],
    ['beta', 'old-beta'],
  ])
})

test('applyBodies drops deselected names and never invents a body', () => {
  const prev = new Map([
    ['alpha', 'old-alpha'],
    ['gone', 'old-gone'],
  ])
  const next = applyBodies(prev, [{ name: 'alpha', state: 'load-failed', reason: 'boom' }], new Map())
  assert.deepEqual([...next], [['alpha', 'old-alpha']])
  assert.deepEqual([...applyBodies(new Map(), [{ name: 'x', state: 'no-scope', reason: 'r' }], new Map())], [])
})

test('classifySelection defaults the reason for an advertised name with no load entry', () => {
  const rows = classifySelection({
    selected: ['alpha'],
    catalog: { kind: 'scoped', names: ['alpha'], complete: true },
    scoped: true,
    loads: new Map(),
  })
  assert.deepEqual(rows, [
    { name: 'alpha', state: 'load-failed', reason: 'skill body could not be loaded' },
  ])
})

test('classifySelection treats an empty load reason as no reason', () => {
  const rows = classifySelection({
    selected: ['alpha'],
    catalog: { kind: 'scoped', names: ['alpha'], complete: true },
    scoped: true,
    loads: new Map([['alpha', { ok: false, reason: '' }]]),
  })
  assert.deepEqual(rows, [
    { name: 'alpha', state: 'load-failed', reason: 'skill body could not be loaded' },
  ])
})

test('applyBodies keeps last-good for both transient states', () => {
  const prev = new Map([
    ['a', 'old-a'],
    ['b', 'old-b'],
  ])
  const next = applyBodies(
    prev,
    [
      { name: 'a', state: 'load-failed', reason: 'boom' },
      { name: 'b', state: 'no-scope', reason: 'waiting' },
    ],
    new Map(),
  )
  assert.deepEqual([...next], [
    ['a', 'old-a'],
    ['b', 'old-b'],
  ])
})

test('applyBodies drops a ready row that has no fresh body', () => {
  const next = applyBodies(new Map([['a', 'OLD']]), [{ name: 'a', state: 'ready' }], new Map())
  assert.deepEqual([...next], [])
})

test('classifySelection never reports an empty catalog-error reason', () => {
  const rows = classifySelection({
    selected: ['alpha'],
    catalog: { kind: 'error', reason: '' },
    scoped: true,
    loads: new Map(),
  })
  assert.deepEqual(rows, [
    { name: 'alpha', state: 'unavailable', reason: 'skill catalog read failed' },
  ])
})

test('cachedSuffix describes a held body differently per mode', () => {
  assert.equal(
    cachedSuffix({ mode: 'each-prompt', injected: [], name: 'ponytail', cached: true }),
    ' · still injecting the last loaded copy',
  )
  assert.equal(
    cachedSuffix({ mode: 'start-only', injected: ['ponytail'], name: 'ponytail', cached: true }),
    ' · already in this session',
  )
  assert.equal(
    cachedSuffix({ mode: 'start-only', injected: [], name: 'ponytail', cached: true }),
    ' · last loaded copy retained',
  )
  assert.equal(cachedSuffix({ mode: 'each-prompt', injected: [], name: 'ponytail', cached: false }), '')
  assert.equal(cachedSuffix({ mode: 'each-prompt', injected: [], name: 'ponytail', cached: undefined }), '')
})
