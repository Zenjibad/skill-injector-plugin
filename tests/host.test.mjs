/**
 * Host-half smoke test: drives the real `apply()` with a stub Cordis context so
 * the resolver, the snapshot, the rendered section, the scope gate, and the
 * two-pass start-only stamp are exercised end to end without a DSH process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const PONYTAIL = {
  name: 'ponytail',
  description: 'lazy senior dev',
  content: 'BODY-PONYTAIL',
  provider: 'filesystem',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'user-agents',
}

/** Stub ctx exposing only the seams the host half dereferences. */
function makeHarness(initialSettings, skills) {
  const routes = new Map()
  const listeners = new Map()
  const sections = []
  const updates = []
  let current = initialSettings
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    settings: {
      register: () => {},
      get: () => current,
      update: async (_ns, patch) => {
        updates.push(patch)
        current = patch
      },
    },
    skills,
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => {}
      },
    },
    on: (event, fn) => {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
  }
  return { ctx, routes, listeners, sections, updates }
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
}

/** GET the snapshot route and parse the JSON body. */
async function snapshot(routes) {
  const res = makeRes()
  await routes.get('/skill-injector/api')({}, res)
  assert.equal(res.status, 200)
  return JSON.parse(res.body)
}

function makeAgent(id, injected, events = []) {
  return {
    id,
    session: { header: { cwd: 'C:/work' }, events },
    inject: (message) => injected.push(message),
  }
}

/** A registry that only answers a scoped read, like the real filesystem provider. */
function scopedRegistry(advertised) {
  return {
    snapshot: async (options) =>
      options === undefined ? { skills: [], complete: true } : { skills: advertised, complete: true },
    list: async (options) => (options === undefined ? [] : advertised),
    get: async (name, options) =>
      options !== undefined && advertised.some((s) => s.name === name)
        ? advertised.find((s) => s.name === name)
        : undefined,
  }
}

test('host classifies, gates Remove on scope, and stamps a cold cache', async () => {
  const h = makeHarness({ mode: 'start-only', selected: ['ponytail', 'llmtrim'] }, scopedRegistry([PONYTAIL]))
  apply(h.ctx)

  // Boot: no agent scope yet, so nothing may be called unknown and Remove is off.
  const boot = await snapshot(h.routes)
  assert.equal(boot.ok, true)
  assert.equal(boot.canRemove, false)
  assert.deepEqual(boot.unresolved, [
    { name: 'ponytail', state: 'no-scope', reason: 'waiting for a session to establish scope' },
    { name: 'llmtrim', state: 'no-scope', reason: 'waiting for a session to establish scope' },
  ])

  // A session starts with a cold cache: pass 1 stamps nothing, pass 2 must stamp.
  const injected = []
  h.listeners.get('agent/session-start')({ agent: makeAgent('session-1', injected), source: 'new' })
  // snapshot() awaits the same in-flight pass this session start kicked off, and
  // the stamp callback was registered first, so the stamp has landed by here.
  const after = await snapshot(h.routes)
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.name, 'ponytail')
  assert.equal(after.canRemove, true)
  assert.deepEqual(after.unresolved, [
    { name: 'llmtrim', state: 'unknown', reason: 'not in the skill catalog' },
  ])
  assert.deepEqual(after.missing, ['llmtrim'])
  assert.deepEqual(after.injected, ['ponytail'])
  assert.deepEqual(after.selected, ['ponytail', 'llmtrim'])

  // Re-firing the same session must not double-stamp.
  h.listeners.get('agent/session-start')({ agent: makeAgent('session-1', injected), source: 'resume' })
  await snapshot(h.routes)
  assert.equal(injected.length, 1)

  // A different session whose log already carries the stamp must not stamp again.
  const second = []
  h.listeners.get('agent/session-start')({
    agent: makeAgent('session-2', second, [
      { type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'ponytail' } } },
    ]),
    source: 'new',
  })
  await snapshot(h.routes)
  assert.equal(second.length, 0)

  // The host never rewrites the stored selection; only the PUT route may.
  assert.equal(h.updates.length, 0)
})

test('a transient failure keeps injecting the last-good body; only unknown drops it', async () => {
  let advertised = [PONYTAIL]
  let complete = true
  let getThrows = false
  const skills = {
    snapshot: async (options) =>
      options === undefined ? { skills: [], complete: true } : { skills: advertised, complete },
    list: async (options) => (options === undefined ? [] : advertised),
    get: async (name, options) => {
      if (options === undefined || name !== 'ponytail') return undefined
      if (getThrows) throw new Error('EACCES')
      return PONYTAIL
    },
  }
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail', 'llmtrim'] }, skills)
  apply(h.ctx)
  const section = () => h.sections[0].text()
  assert.equal(section(), '')

  // Scope arrives, then a clean pass renders the body into the section.
  const injected = []
  h.listeners.get('agent/session-start')({ agent: makeAgent('s1', injected), source: 'new' })
  await snapshot(h.routes)
  assert.match(section(), /BODY-PONYTAIL/)

  // A failing body load is transient: reported per skill, still injected.
  getThrows = true
  const failed = await snapshot(h.routes)
  assert.deepEqual(failed.unresolved, [
    { name: 'ponytail', state: 'load-failed', reason: 'EACCES' },
    { name: 'llmtrim', state: 'unknown', reason: 'not in the skill catalog' },
  ])
  assert.match(section(), /BODY-PONYTAIL/)

  // Incomplete discovery is transient too, and must never read as a deletion.
  getThrows = false
  advertised = []
  complete = false
  const partial = await snapshot(h.routes)
  assert.deepEqual(partial.unresolved.map((u) => [u.name, u.state, u.reason]), [
    ['ponytail', 'unavailable', 'provider discovery incomplete'],
    ['llmtrim', 'unavailable', 'provider discovery incomplete'],
  ])
  assert.match(section(), /BODY-PONYTAIL/)

  // Only a complete, scoped read that no longer advertises the name drops it.
  complete = true
  const gone = await snapshot(h.routes)
  assert.equal(gone.unresolved[0].state, 'unknown')
  assert.equal(section(), '')
})

test('a newly established scope does not inherit an in-flight unscoped pass', async () => {
  let release
  const parked = new Promise((resolve) => {
    release = resolve
  })
  let snapshotCalls = 0
  const skills = {
    snapshot: async (options) => {
      snapshotCalls += 1
      if (options === undefined) {
        await parked
        return { skills: [], complete: true }
      }
      return { skills: [PONYTAIL], complete: true }
    },
    list: async (options) => (options === undefined ? [] : [PONYTAIL]),
    get: async (name, options) => (options !== undefined && name === 'ponytail' ? PONYTAIL : undefined),
  }
  const h = makeHarness({ mode: 'start-only', selected: ['ponytail', 'llmtrim'] }, skills)
  apply(h.ctx) // the boot pass parks on its unscoped catalog read

  const injected = []
  h.listeners.get('agent/session-start')({ agent: makeAgent('s1', injected), source: 'new' })
  const scoped = await snapshot(h.routes)

  // Scoped truth, not the parked boot pass's unscoped rows. Before the pass key
  // existed this snapshot joined the parked pass and reported both as no-scope.
  assert.equal(scoped.canRemove, true)
  assert.deepEqual(scoped.unresolved, [
    { name: 'llmtrim', state: 'unknown', reason: 'not in the skill catalog' },
  ])
  assert.ok(snapshotCalls >= 2, 'a scope change must start its own pass')

  // The stale pass settling last must not overwrite the scoped result.
  release()
  await parked
  const settled = await snapshot(h.routes)
  assert.equal(settled.canRemove, true)
  assert.deepEqual(settled.unresolved.map((u) => u.name), ['llmtrim'])
})

test('identical concurrent triggers share one catalog read', async () => {
  let snapshotCalls = 0
  const skills = {
    snapshot: async (options) => {
      snapshotCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return options === undefined ? { skills: [], complete: true } : { skills: [PONYTAIL], complete: true }
    },
    list: async (options) => (options === undefined ? [] : [PONYTAIL]),
    get: async (name, options) => (options !== undefined && name === 'ponytail' ? PONYTAIL : undefined),
  }
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, skills)
  apply(h.ctx)
  await snapshot(h.routes)
  const before = snapshotCalls

  await Promise.all([snapshot(h.routes), snapshot(h.routes)])
  assert.equal(snapshotCalls - before, 1)
})
