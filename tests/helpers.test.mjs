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
