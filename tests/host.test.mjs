/**
 * Host-half smoke test: drives the real `apply()` with a stub Cordis context so
 * the resolver, the snapshot, the rendered section, the scope gate, and the
 * two-pass start-only stamp are exercised end to end without a DSH process.
 *
 * Contract notes for the DSH >= 0.2 host this suite targets:
 *  - the plugin's settings ARE its Loader Config, handed to `apply(ctx, config)`
 *    as schemastery `.volatile()` references; a settings write commits into
 *    those same references and emits `loader/volatile-update` instead of
 *    reloading the entry (see `commitConfig` below),
 *  - persistence goes through `settings.update(entryId, patch)`,
 *  - `agent/created` replaced `agent/session-start` (serial + awaited),
 *  - `session.ownEvents()` replaced the public `session.events` getter.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name as pluginName, inject as injectDeps, Config } from '../lib/index.js'

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

/** A live Config as the Loader presents it: schemastery `.volatile()` refs. */
function makeConfig(initial) {
  let mode = initial.mode
  let selected = initial.selected
  return {
    config: { mode: { get: () => mode }, selected: { get: () => selected } },
    current: () => ({ mode, selected }),
    commit(patch) {
      if (patch.mode !== undefined) mode = patch.mode
      if (patch.selected !== undefined) selected = patch.selected
    },
  }
}

/** Stub ctx exposing only the seams the host half dereferences. */
function makeHarness(initial, skills, services = {}) {
  const store = makeConfig(initial)
  const routes = new Map()
  const listeners = new Map()
  const sections = []
  const updates = []
  const configured = []

  const emit = async (event, payload) => {
    for (const fn of listeners.get(event) ?? []) await fn(payload)
  }

  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    // Optional-service lookup: `loader` (entry id) and `agents` (scope recovery).
    get: (serviceName) => services[serviceName],
    logger: { warn: () => {} },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    settings: {
      configure: (presentation) => {
        configured.push(presentation)
        return () => {}
      },
      // The real service merges the patch into the entry Config, which for
      // volatile fields means updating the live refs and announcing it.
      update: async (ns, patch) => {
        updates.push([ns, patch])
        store.commit(patch)
        await emit('loader/volatile-update', [['mode'], ['selected']])
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
      const set = listeners.get(event) ?? []
      set.push(fn)
      listeners.set(event, set)
      return () => {
        const i = set.indexOf(fn)
        if (i >= 0) set.splice(i, 1)
      }
    },
  }

  return {
    ctx,
    config: store.config,
    routes,
    sections,
    updates,
    configured,
    services,
    emit,
    current: store.current,
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
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

/** A live-agent stub with the DSH >= 0.2 history accessor. */
function makeAgent(id, injected, events = []) {
  return {
    id,
    session: { header: { cwd: 'C:/work' }, ownEvents: () => events },
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

test('the entry declares a volatile Config schema, its service deps, and its name', () => {
  assert.equal(pluginName, 'skill-injector-plugin')
  assert.deepEqual(injectDeps, ['webServer', 'settings', 'skills', 'systemPrompt'])

  // cordis validates a plugin Config through the Standard-Schema probe.
  const std = Config['~standard']
  assert.equal(typeof std?.validate, 'function')

  // Every field must be volatile: `settings.update()` refuses a non-volatile
  // field, and the Loader only commits volatile-only changes in place.
  const resolved = std.validate({}).value
  assert.deepEqual(resolved.mode.get(), 'each-prompt')
  assert.deepEqual(resolved.selected.get(), [])
  assert.deepEqual(Config({ mode: 'start-only' }).selected.get(), [])
  assert.ok(std.validate({ mode: 'nope' }).issues.length > 0, 'an unknown mode must be rejected')
})

test('host classifies, gates Remove on scope, and stamps a cold cache', async () => {
  const h = makeHarness({ mode: 'start-only', selected: ['ponytail', 'llmtrim'] }, scopedRegistry([PONYTAIL, HIDDEN]))
  apply(h.ctx, h.config)

  // The bundle ships its own settings page, so the generated one is disabled.
  assert.deepEqual(h.configured, [{ auto: false }])

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
  await h.emit('agent/created', { agent: makeAgent('session-1', injected), source: 'new' })
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
  await h.emit('agent/created', { agent: makeAgent('session-1', injected), source: 'resume' })
  await snapshot(h.routes)
  assert.equal(injected.length, 1)

  // A different session whose log already carries the stamp must not stamp again.
  const second = []
  await h.emit('agent/created', {
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

test('dedupe still reads a pre-0.2 `session.events` agent', async () => {
  const h = makeHarness({ mode: 'start-only', selected: ['ponytail'] }, scopedRegistry([PONYTAIL]))
  apply(h.ctx, h.config)
  const injected = []
  await h.emit('agent/created', {
    agent: {
      id: 'legacy',
      // No ownEvents/snapshotEvents: only the pre-0.2 array accessor.
      session: {
        header: { cwd: 'C:/work' },
        events: [{ type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'ponytail' } } }],
      },
      inject: (message) => injected.push(message),
    },
    source: 'resume',
  })
  assert.equal(injected.length, 0)
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
  apply(h.ctx, h.config)
  const section = () => h.sections[0].text()
  assert.equal(typeof h.sections[0]?.text, 'function')
  assert.equal(section(), '')

  // Scope arrives, then a clean pass renders the body into the section.
  const injected = []
  await h.emit('agent/created', { agent: makeAgent('s1', injected), source: 'new' })
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
  apply(h.ctx, h.config) // the boot pass parks on its unscoped catalog read
  assert.equal(typeof h.sections[0]?.text, 'function')

  const injected = []
  void h.emit('agent/created', { agent: makeAgent('s1', injected), source: 'new' })
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
  apply(h.ctx, h.config)
  await snapshot(h.routes)
  const before = snapshotCalls

  await Promise.all([snapshot(h.routes), snapshot(h.routes)])
  assert.equal(snapshotCalls - before, 1)
})

test('a live agent supplies the lookup scope after a re-apply, and disposal clears it', async () => {
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  const skills = {
    snapshot: async (options) =>
      scoped(options) ? { skills: [PONYTAIL], complete: true } : { skills: [], complete: true },
    list: async (options) => (scoped(options) ? [PONYTAIL] : []),
    get: async (name, options) => (scoped(options) && name === 'ponytail' ? PONYTAIL : undefined),
  }
  // No `agent/created` ever fired for this instance: exactly the state a reload
  // leaves behind (the Loader re-applies the plugin on a non-volatile change).
  const agent = makeAgent('survivor', [])
  let live = [agent]
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, skills, { agents: { list: () => live } })
  apply(h.ctx, h.config)

  const recovered = await snapshot(h.routes)
  assert.equal(recovered.canRemove, true)
  assert.deepEqual(recovered.available, [{ name: 'ponytail', description: 'lazy senior dev' }])
  assert.deepEqual(recovered.unresolved, [])

  // A disposed agent must stop being the scope: the plugin reverts to the
  // pre-scope posture (no-scope, Remove off) instead of resolving against a
  // dead scope and calling every name `unknown`.
  live = []
  await h.emit('agent/disposed', { agent })
  const disposed = await snapshot(h.routes)
  assert.deepEqual(disposed.unresolved, [
    { name: 'ponytail', state: 'no-scope', reason: 'waiting for a session to establish scope', cached: true },
  ])
})

test('a Save persists the entry Config and takes effect without a reload', async () => {
  const h = makeHarness({ mode: 'each-prompt', selected: [] }, scopedRegistry([PONYTAIL]), {
    loader: { entries: () => [{ options: { id: 'renamed-entry', name: 'skill-injector-plugin' } }] },
  })
  apply(h.ctx, h.config)
  const section = () => h.sections[0].text()
  await h.emit('agent/created', { agent: makeAgent('s1', []), source: 'new' })
  await snapshot(h.routes)
  assert.equal(section(), '')

  const put = async (body) => {
    const res = makeRes()
    await h.routes.get('/skill-injector/api/config')([body], res)
    return { status: res.status, snap: JSON.parse(res.body) }
  }

  const ok = await put(JSON.stringify({ mode: 'each-prompt', selected: ['ponytail'] }))
  assert.equal(ok.status, 200)
  assert.equal(ok.snap.ok, true)
  assert.deepEqual(ok.snap.selected, ['ponytail'])
  // Persisted as the Loader entry's Config, addressed by the profile entry id.
  assert.deepEqual(h.updates, [['renamed-entry', { mode: 'each-prompt', selected: ['ponytail'] }]])

  // The same instance now serves the new selection: no re-apply, no lost scope.
  const afterSave = await snapshot(h.routes)
  assert.deepEqual(afterSave.selected, ['ponytail'])
  assert.match(section(), /BODY-PONYTAIL/)

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
  apply(eachPrompt.ctx, eachPrompt.config)
  await eachPrompt.emit('agent/created', { agent: makeAgent('s1', []), source: 'new' })
  await snapshot(eachPrompt.routes)
  assert.match(eachPrompt.sections[0].text(), /&#123;&#123;model}}/)
  assert.ok(!eachPrompt.sections[0].text().includes('{{model}}'), 'the section must not keep raw braces')

  const startOnly = makeHarness({ mode: 'start-only', selected: ['ponytail'] }, scopedRegistry([braced]))
  apply(startOnly.ctx, startOnly.config)
  const injected = []
  await startOnly.emit('agent/created', { agent: makeAgent('s2', injected), source: 'new' })
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /\{\{model\}\}/)
})
