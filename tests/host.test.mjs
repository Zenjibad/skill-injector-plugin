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

/** Advertised by the catalog, but not model invocable, so never `available`. */
const HIDDEN = {
  name: 'secret',
  description: 'not model invocable',
  content: 'BODY-SECRET',
  provider: 'filesystem',
  invocation: { modelInvocable: false, userInvocable: true },
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
        // Cordis merges the patch into the stored user section.
        current = { ...current, ...patch }
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
  return { ctx, routes, listeners, sections, updates, setSettings: (value) => { current = value } }
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

/** A registry that only answers a scoped read, like the real filesystem provider.
 *  `cwd` is required too: the repo contract is `{ scope, cwd }`, so a regression
 *  that drops the cwd must fail this suite. */
function scopedRegistry(advertised) {
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  return {
    snapshot: async (options) =>
      scoped(options) ? { skills: advertised, complete: true } : { skills: [], complete: true },
    list: async (options) => (scoped(options) ? advertised : []),
    get: async (name, options) => (scoped(options) ? advertised.find((s) => s.name === name) : undefined),
  }
}

test('host classifies, gates Remove on scope, and stamps a cold cache', async () => {
  const h = makeHarness({ mode: 'start-only', selected: ['ponytail', 'llmtrim'] }, scopedRegistry([PONYTAIL, HIDDEN]))
  apply(h.ctx)

  // Boot: no agent scope yet, so nothing may be called unknown and Remove is off.
  const boot = await snapshot(h.routes)
  assert.equal(boot.ok, true)
  assert.equal(boot.canRemove, false)
  assert.deepEqual(boot.available, [])
  assert.deepEqual(boot.unresolved, [
    { name: 'ponytail', state: 'no-scope', reason: 'waiting for a session to establish scope', cached: false },
    { name: 'llmtrim', state: 'no-scope', reason: 'waiting for a session to establish scope', cached: false },
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
  // HIDDEN is advertised but filtered out here because it is not model-invocable.
  assert.deepEqual(after.available, [{ name: 'ponytail', description: 'lazy senior dev' }])
  assert.deepEqual(after.unresolved, [
    { name: 'llmtrim', state: 'unknown', reason: 'not in the skill catalog', cached: false },
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
      {
        type: 'user/message',
        data: { source: { kind: 'skill-invocation', name: 'ponytail', form: 'instructions' } },
      },
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
  let snapshotThrows = false
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  const skills = {
    snapshot: async (options) => {
      if (snapshotThrows) throw new Error('registry exploded')
      return scoped(options) ? { skills: advertised, complete } : { skills: [], complete: true }
    },
    list: async (options) => (scoped(options) ? advertised : []),
    get: async (name, options) => {
      if (!scoped(options) || name !== 'ponytail') return undefined
      if (getThrows) throw new Error('EACCES')
      return PONYTAIL
    },
  }
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail', 'llmtrim'] }, skills)
  apply(h.ctx)
  const section = () => h.sections[0].text()
  assert.equal(typeof h.sections[0]?.text, 'function')
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
    { name: 'ponytail', state: 'load-failed', reason: 'EACCES', cached: true },
    { name: 'llmtrim', state: 'unknown', reason: 'not in the skill catalog', cached: false },
  ])
  assert.match(section(), /BODY-PONYTAIL/)

  // A failed catalog read is unavailable with the thrown message, still transient.
  snapshotThrows = true
  const errored = await snapshot(h.routes)
  assert.deepEqual(errored.unresolved.map((u) => [u.name, u.state, u.reason]), [
    ['ponytail', 'unavailable', 'registry exploded'],
    ['llmtrim', 'unavailable', 'registry exploded'],
  ])
  assert.match(section(), /BODY-PONYTAIL/)
  snapshotThrows = false

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

test('a newly established scope does not inherit an in-flight unscoped pass', { timeout: 5000 }, async () => {
  let release
  const parked = new Promise((resolve) => {
    release = resolve
  })
  let snapshotCalls = 0
  let snapshotOptions
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  const skills = {
    snapshot: async (options) => {
      snapshotCalls += 1
      if (options !== undefined) snapshotOptions = options
      if (!scoped(options)) {
        await parked
        return { skills: [], complete: true }
      }
      return { skills: [PONYTAIL], complete: true }
    },
    list: async (options) => (scoped(options) ? [PONYTAIL] : []),
    get: async (name, options) => (scoped(options) && name === 'ponytail' ? PONYTAIL : undefined),
  }
  const h = makeHarness({ mode: 'start-only', selected: ['ponytail', 'llmtrim'] }, skills)
  apply(h.ctx) // the boot pass parks on its unscoped catalog read
  assert.equal(typeof h.sections[0]?.text, 'function')

  const injected = []
  h.listeners.get('agent/session-start')({ agent: makeAgent('s1', injected), source: 'new' })
  // The scope-change read must carry the repo's `{ scope, cwd }` contract.
  assert.equal(snapshotOptions.cwd, 'C:/work')
  const scopedSnap = await snapshot(h.routes)

  // Scoped truth, not the parked boot pass's unscoped rows. Before the pass key
  // existed this snapshot joined the parked pass and reported both as no-scope.
  assert.equal(scopedSnap.canRemove, true)
  assert.deepEqual(scopedSnap.unresolved, [
    { name: 'llmtrim', state: 'unknown', reason: 'not in the skill catalog', cached: false },
  ])
  // Exactly two reads: the boot read plus the scope change's own read. A pass
  // that joined the parked unscoped one instead would make this one.
  assert.equal(snapshotCalls, 2)

  // The stale pass settling last must not overwrite the scoped result.
  release()
  await parked
  const settled = await snapshot(h.routes)
  assert.equal(settled.canRemove, true)
  assert.deepEqual(settled.unresolved.map((u) => u.name), ['llmtrim'])
})

test('identical concurrent triggers share one catalog read', async () => {
  let snapshotCalls = 0
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  const skills = {
    snapshot: async (options) => {
      snapshotCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return scoped(options) ? { skills: [PONYTAIL], complete: true } : { skills: [], complete: true }
    },
    list: async (options) => (scoped(options) ? [PONYTAIL] : []),
    get: async (name, options) => (scoped(options) && name === 'ponytail' ? PONYTAIL : undefined),
  }
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, skills)
  apply(h.ctx)
  await snapshot(h.routes)
  const before = snapshotCalls

  await Promise.all([snapshot(h.routes), snapshot(h.routes)])
  assert.equal(snapshotCalls - before, 1)
})

test('a stale pass settling late cannot resurrect a dropped body', async () => {
  let release
  const parked = new Promise((resolve) => {
    release = resolve
  })
  // Resolved once the parked pass has walked past its own commit point.
  // `await parked` alone is not enough: the host's pass still has a `.finally()`
  // and a `.then()` hop to cross, so the assertion would run *before* the commit
  // and the guard could be deleted with this test staying green.
  let parkedDone
  const settled = new Promise((resolve) => {
    parkedDone = resolve
  })
  let parkedOnce = false
  let advertised = [PONYTAIL]
  let snapshotOptions
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  const skills = {
    snapshot: async (options) => {
      if (options !== undefined) snapshotOptions = options
      if (scoped(options) && !parkedOnce) {
        parkedOnce = true
        await parked // park the first scoped pass
        return { skills: [PONYTAIL], complete: true }
      }
      return scoped(options) ? { skills: advertised, complete: true } : { skills: [], complete: true }
    },
    list: async (options) => (scoped(options) ? advertised : []),
    get: async (name, options) => {
      const out = scoped(options) && name === 'ponytail' ? PONYTAIL : undefined
      if (parkedOnce) parkedDone()
      return out
    },
  }
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, skills)
  apply(h.ctx)
  const section = () => h.sections[0].text()
  assert.equal(typeof h.sections[0]?.text, 'function')

  // The scope arrives while the first scoped pass is still parked.
  const injected = []
  h.listeners.get('agent/session-start')({ agent: makeAgent('s1', injected), source: 'new' })
  // Pin the `{ scope, cwd }` contract where the registry sees it: without a
  // forwarded cwd the pass below never parks and this test would hang instead of
  // failing, so this assertion is what makes a dropped cwd fail fast.
  assert.equal(snapshotOptions.cwd, 'C:/work')
  assert.equal(section(), '')

  // A newer pass with a different selection sees a complete catalog without the
  // skill, so it drops the body.
  h.setSettings({ mode: 'each-prompt', selected: ['ponytail', 'llmtrim'] })
  advertised = []
  h.listeners.get('settings/updated')('skill-injector')
  const gone = await snapshot(h.routes)
  assert.deepEqual(gone.unresolved.map((u) => [u.name, u.state]), [
    ['ponytail', 'unknown'],
    ['llmtrim', 'unknown'],
  ])
  assert.equal(section(), '')

  // The parked pass settles last still holding a body for a name that is gone.
  // Without the pass-id commit guard this resurrects it into the section.
  release()
  await settled
  // The commit is a handful of microtasks past the body load: one per awaited
  // leg (snapshot, get) plus the pass's own `.finally()`/`.then()` wrappers.
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.equal(section(), '')
})

test('the config route validates before it writes and always answers JSON', async () => {
  const h = makeHarness({ mode: 'each-prompt', selected: [] }, scopedRegistry([PONYTAIL]))
  apply(h.ctx)

  const put = async (body) => {
    const res = makeRes()
    await h.routes.get('/skill-injector/api/config')([body], res)
    return { status: res.status, snap: JSON.parse(res.body) }
  }

  const ok = await put(JSON.stringify({ mode: 'start-only', selected: ['ponytail'] }))
  assert.equal(ok.status, 200)
  assert.equal(ok.snap.ok, true)
  assert.equal(ok.snap.mode, 'start-only')
  assert.deepEqual(ok.snap.selected, ['ponytail'])
  assert.deepEqual(h.updates, [{ mode: 'start-only', selected: ['ponytail'] }])

  const malformed = await put('{not json')
  assert.equal(malformed.status, 400)
  assert.equal(malformed.snap.ok, false)
  assert.equal(typeof malformed.snap.error, 'string')

  const invalid = await put(JSON.stringify({ mode: 'nope', selected: [] }))
  assert.equal(invalid.status, 400)
  assert.equal(invalid.snap.ok, false)
})

test('the section escapes braces while a stamped message stays raw', async () => {
  const braced = { ...PONYTAIL, content: 'uses {{model}} verbatim' }

  const eachPrompt = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, scopedRegistry([braced]))
  apply(eachPrompt.ctx)
  const skipped = []
  eachPrompt.listeners.get('agent/session-start')({ agent: makeAgent('s1', skipped), source: 'new' })
  await snapshot(eachPrompt.routes)
  assert.match(eachPrompt.sections[0].text(), /&#123;&#123;model}}/)
  assert.ok(!eachPrompt.sections[0].text().includes('{{model}}'), 'the section must not keep raw braces')

  const startOnly = makeHarness({ mode: 'start-only', selected: ['ponytail'] }, scopedRegistry([braced]))
  apply(startOnly.ctx)
  const injected = []
  startOnly.listeners.get('agent/session-start')({ agent: makeAgent('s2', injected), source: 'new' })
  await snapshot(startOnly.routes)
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /\{\{model\}\}/)
})
