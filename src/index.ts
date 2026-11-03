/**
 * skill-injector-plugin — host half.
 *
 * Owns the injector's configuration (mode + selected skills), loads skill
 * bodies from the `ctx.skills` registry, and injects them into sessions two
 * ways:
 *   - `each-prompt`: a systemPrompt.section re-rendered every assembly,
 *   - `start-only`: agent.inject() on `agent/created` (one durable user/message
 *     stamped per skill, deduped against session history).
 * Serves the snapshot to the client bundle over HTTP
 * (`GET /skill-injector/api`) and accepts selection writes
 * (`PUT /skill-injector/api/config`).
 *
 * DSH >= 0.2 settings model: a plugin's settings ARE its Loader entry Config.
 * The imperative `settings.register(ns, schema, { base })` / `settings.get(ns)`
 * namespace API is gone — the schema below is exported as `Config`, the Loader
 * hands the resolved value to `apply()`, and writes go through
 * `settings.update(entryId, patch)`, which persists into the profile patch and
 * reconciles the entry (so this plugin is re-applied with the new Config).
 *
 * Runtime note: packaged profile plugins are real Node modules — process.env,
 * Date, Buffer, and async iteration over req all work here.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isModelInvocable, renderSkillContent, type SkillResourceBase, type SkillSummary } from '@deepseek-ai/dsh-skill'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  applyBodies,
  buildInjectionMessage,
  classifySelection,
  escapePromptBraces,
  validateSelection,
  type CatalogObservation,
  type ClassifiedSkill,
  type InjectorConfig,
  type LoadOutcome,
} from './helpers.js'

export const name = 'skill-injector-plugin'

/** Loader row name; the profile entry id unless the composition renames it. */
const ENTRY_NAME = 'skill-injector-plugin'
const SECTION_NAME = 'skill-injector:active'
const SECTION_ORDER = 150
/** Upper bound on the cold-cache resolve awaited at `agent/created`. */
const STAMP_RESOLVE_DEADLINE_MS = 3000
/** Bound on the per-agent stamp ledger. */
const MAX_TRACKED_AGENTS = 200

/**
 * The plugin's Config — this schema IS the settings namespace under DSH >= 0.2.
 * Schemastery defaults make every field optional in the profile patch, so an
 * entry mounted with no `config:` block resolves to "each-prompt, nothing
 * selected". The native configuration form is generated from this schema
 * (`auto: false` turns that page off — the bundle ships its own).
 *
 * Both fields are `.volatile()` on purpose. `ctx.settings.update()` refuses to
 * write a field that is not "volatile", and the Loader compares a config change
 * field-by-field for volatile nodes: a write that touches only these fields is
 * committed IN PLACE (the same wrappers get new values and
 * `loader/volatile-update` fires) instead of reloading the entry. That is what
 * keeps this plugin's route registrations, body cache and agent scope alive
 * across a Save.
 */
export const Config = z.object({
  mode: z.union([z.const('each-prompt'), z.const('start-only')]).default('each-prompt').volatile(),
  selected: z.array(z.string()).default([]).volatile(),
})

// Hard deps: webServer serves the routes, settings persists the selection,
// skills loads skill bodies, systemPrompt owns the each-prompt section.
export const inject = ['webServer', 'settings', 'skills', 'systemPrompt']

interface SkillDef {
  name: string
  description: string
  content: string
  provider: string
  resourceBase?: SkillResourceBase
}

/** The shape of one entry in a session's immutable event log (read-only here). */
interface SessionEventLike {
  type?: string
  data?: any
}

/** The subset of a live agent this plugin reads (see `agent/created`). */
interface SessionAgent {
  id?: string
  session?: {
    header?: { cwd?: string }
    /** DSH >= 0.2: this session's events after the fork-inherited prefix. */
    ownEvents?: () => SessionEventLike[]
    /** Deprecated on 0.2 but present, and the whole-history read on older hosts. */
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => SessionEventLike[]
    /** Pre-0.2 accessor kept as a fallback so dedupe still works there. */
    events?: SessionEventLike[]
  }
  inject?: (message: unknown) => void
}

interface Snapshot {
  ok: boolean
  error?: string
  mode: InjectorConfig['mode']
  selected: string[]
  available: Array<{ name: string; description: string }>
  unresolved: UnresolvedSkill[]
  /** Derived from `unresolved`; see buildSnapshot for why it still exists. */
  missing: string[]
  injected: string[]
  /** True once a scoped resolve has run, so the UI never offers Remove off the boot race. */
  canRemove: boolean
}

/** One classification pass: the inputs it was computed from, plus its rows. */
interface ResolvePass {
  key: string
  mode: InjectorConfig['mode']
  selected: string[]
  rows: ClassifiedSkill[]
  /** Names holding a last-good body after this pass, so `cached` describes this pass. */
  cached: ReadonlySet<string>
}

/** An unresolved row as the UI sees it: the classification, plus whether a
 *  last-good body is still being injected in its place. */
interface UnresolvedSkill extends ClassifiedSkill {
  cached: boolean
}

/** The Loader's view of one entry, read only to learn this plugin's entry id. */
interface LoaderLike {
  entries?: () => Array<{ options?: { id?: string; name?: string } }>
}

type HostCtx = {
  /** Cordis service lookup; used for optional services (loader, agents). */
  get?: (name: string) => unknown
  logger?: { warn?: (message: string) => void }
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: {
        method?: string
        [k: string]: unknown
      } & AsyncIterable<unknown>, res: {
        writeHead(status: number, headers: Record<string, string>): void
        end(body: string): void
      }) => void | Promise<void>
    }): () => void
  }
  settings: {
    /** DSH >= 0.2: opt out of the schema-generated page (we ship our own). */
    configure?: (presentation: { auto?: boolean }) => () => void
    /** DSH >= 0.2: merge fields into the Loader entry's Config. */
    update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  }
  skills: {
    list(options?: Record<string, unknown>): Promise<SkillSummary[]>
    /** Catalog + discovery completeness: `complete: false` means "retry later", never "deleted". */
    snapshot(options?: Record<string, unknown>): Promise<{ skills: SkillSummary[]; complete: boolean }>
    get(name: string, options?: Record<string, unknown>): Promise<SkillDef | undefined>
  }
  systemPrompt: {
    section(section: { name: string; order: number; text: string | (() => string) }): () => void
  }
  on(event: string, listener: (...args: any[]) => any): () => void
}

/** A schemastery `.volatile()` output: a stable reference whose value is read live. */
interface VolatileValue<T> {
  get(): T
}

/** The resolved Config object the Loader hands to `apply()`. */
interface PluginConfig {
  mode?: VolatileValue<string> | string
  selected?: VolatileValue<string[]> | string[]
}

/** Unwrap a volatile reference, tolerating a plain value (older hosts, tests). */
function readLive<T>(value: VolatileValue<T> | T | undefined, fallback: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as VolatileValue<T>).get === 'function') {
    const live = (value as VolatileValue<T>).get()
    return live === undefined ? fallback : live
  }
  return (value as T | undefined) ?? fallback
}

/** Normalize the Loader-supplied Config into a validated InjectorConfig. */
function resolveConfig(raw: { mode?: unknown; selected?: unknown }): InjectorConfig {
  const r = validateSelection({
    mode: raw.mode ?? 'each-prompt',
    selected: Array.isArray(raw.selected) ? raw.selected : [],
  })
  return r.ok ? r.config : { mode: 'each-prompt', selected: [] }
}

/**
 * Resolve with the promise's value, or with `undefined` once `ms` elapses.
 * Used to bound the cold-cache resolve awaited inside `agent/created`, which
 * is a serial event: a wedged skill scan must never wedge session creation.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: T | undefined): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => finish(undefined), ms)
    promise.then((value) => finish(value), () => finish(undefined))
  })
}

export function apply(ctx: Context, pluginConfig?: PluginConfig): void {
  const c = ctx as unknown as HostCtx
  const { webServer, settings, skills, systemPrompt } = c

  /**
   * The live configuration. Both Config fields are volatile, so a settings
   * write commits into the same wrappers and only emits
   * `loader/volatile-update` — reading through the wrappers is what makes a
   * Save take effect without an entry reload (and without losing the body
   * cache or the agent scope).
   */
  function config(): InjectorConfig {
    return resolveConfig({
      mode: readLive(pluginConfig?.mode, 'each-prompt'),
      selected: readLive(pluginConfig?.selected, []),
    })
  }

  /** This plugin's profile entry id, which is what `settings.update` addresses. */
  const ENTRY_ID = ((): string => {
    try {
      const rows = (c.get?.('loader') as LoaderLike | undefined)?.entries?.() ?? []
      const own = rows.find((row) => row.options?.name === ENTRY_NAME && typeof row.options.id === 'string')
      return own?.options?.id ?? ENTRY_NAME
    } catch {
      return ENTRY_NAME
    }
  })()

  // The bundle ships its own settings page, so the schema-generated one would
  // be a duplicate. Guarded: `configure` is newer than the Config model itself.
  if (typeof settings.configure === 'function') {
    try {
      ctx.effect(() => settings.configure?.({ auto: false }) as () => void)
    } catch {
      // contained: a host that refuses the policy still gets the custom page
    }
  }

  /** name -> last-good skill body. Replaced only on `ready`; see applyBodies. */
  let bodies = new Map<string, SkillDef>()
  /** True once a pass ran with an agent scope; gates the UI's Remove action. */
  let hasScopedRead = false
  /** agentId -> skill names stamped in start-only mode. */
  const injectedByAgent = new Map<string, string[]>()
  let currentAgentId: string | null = null
  /** Live agent handle (used as the skills lookup scope) + its workspace cwd. */
  let currentAgent: SessionAgent | null = null
  /**
   * In-flight resolve plus the selection/scope key it was computed from, so
   * concurrent triggers share a pass only when they agree on both.
   */
  let refreshInFlight: { key: string; promise: Promise<ResolvePass> } | null = null
  /** Monotonic pass id: a slower older pass must never commit over a newer one. */
  let passSeq = 0

  /** Message text of an unknown throw, for a user-facing reason string. */
  function errorText(e: unknown): string {
    return String((e as Error)?.message ?? e)
  }

  /** Remember the scope a read should use, keeping the injected list truthful. */
  function remember(agent: SessionAgent): void {
    if (agent === null || agent.id === undefined || agent.inject === undefined) return
    currentAgent = agent
    currentAgentId = agent.id
  }

  /**
   * Recover a live agent from the registry.
   *
   * A volatile save commits in place, but this entry can still be RE-APPLIED
   * (an ordinary config field, a rebuild, a loader reload), and the fresh
   * instance starts with no scope: without this, the settings page would report
   * `no-scope` and an empty catalog until the next session opened. The registry
   * only holds live agents, and `agent/disposed` clears a remembered one, so a
   * recovered scope is never a disposed scope.
   */
  function discoverAgent(): SessionAgent | null {
    try {
      const get = c.get
      if (typeof get !== 'function') return null
      const agents = get.call(c, 'agents') as { list?: () => SessionAgent[] } | undefined
      const rows = agents?.list?.() ?? []
      return rows[rows.length - 1] ?? null
    } catch {
      return null
    }
  }

  /** Skill lookups MUST use the live agent's scope: the filesystem provider
   * registers in the agent preset's layer, so a host-global lookup is empty. */
  function lookupOptions(): { scope: unknown; cwd?: string } | undefined {
    const agent = currentAgent ?? discoverAgent()
    if (agent === null) return undefined
    remember(agent)
    const cwd = agent.session?.header?.cwd
    return cwd !== undefined ? { scope: agent, cwd } : { scope: agent }
  }

  /**
   * One classification pass over the current selection. Reads the catalog once
   * (with its completeness flag), loads bodies only for advertised names, then
   * applies the result to the last-good body map.
   *
   * A pass is shared only with a trigger that agrees on the selection and the
   * scope: a save or a newly arrived scope must not inherit rows computed from
   * the previous ones. Only the newest pass may commit bodies, so a pass that
   * settles late cannot speak for a selection it no longer describes.
   */
  function resolveSelection(): Promise<ResolvePass> {
    // One snapshot per pass: a Save landing mid-pass must not make the rows and
    // the selection they describe disagree.
    const cfg = config()
    const options = lookupOptions()
    const key = (options !== undefined ? 'scoped:' : 'unscoped:') + cfg.selected.join(',')
    if (refreshInFlight !== null && refreshInFlight.key === key) return refreshInFlight.promise
    const seq = ++passSeq
    const promise = (async (): Promise<ResolvePass> => {
      // Snapshot the last-good map this pass starts from: a pass that loses the
      // seq race must still report `cached` for its own rows.
      const prevBodies = bodies
      const scoped = options !== undefined
      if (scoped) hasScopedRead = true

      let catalog: CatalogObservation
      try {
        const observation = await skills.snapshot(options)
        catalog = {
          kind: 'scoped',
          names: observation.skills.map((s) => s.name),
          complete: observation.complete,
        }
      } catch (e) {
        catalog = { kind: 'error', reason: errorText(e) }
      }

      const advertised = new Set(catalog.kind === 'scoped' ? catalog.names : [])
      const loads = new Map<string, LoadOutcome>()
      const fresh = new Map<string, SkillDef>()
      for (const skillName of cfg.selected) {
        if (!advertised.has(skillName)) continue
        try {
          const skill = await skills.get(skillName, options)
          if (skill === undefined || typeof skill.content !== 'string') {
            loads.set(skillName, { ok: false, reason: 'skill body could not be loaded' })
            continue
          }
          fresh.set(skillName, {
            name: skill.name,
            description: skill.description,
            content: skill.content,
            provider: skill.provider,
            ...(skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}),
          })
          loads.set(skillName, { ok: true })
        } catch (e) {
          loads.set(skillName, { ok: false, reason: errorText(e) })
        }
      }

      const rows = classifySelection({ selected: cfg.selected, catalog, scoped, loads })
      // Compute this pass's body map even when a newer pass already superseded it,
      // so `cached` always describes the rows it is returned with. Only the newest
      // pass may publish it.
      const nextBodies = applyBodies(prevBodies, rows, fresh)
      if (seq === passSeq) bodies = nextBodies
      return { key, mode: cfg.mode, selected: cfg.selected, rows, cached: new Set(nextBodies.keys()) }
    })().finally(() => {
      if (refreshInFlight !== null && refreshInFlight.promise === promise) refreshInFlight = null
    })
    refreshInFlight = { key, promise }
    return promise
  }

  /** Concatenated <skill_content> blocks for the selection (each-prompt path). */
  function renderActiveSkills(): string {
    const blocks: string[] = []
    for (const skillName of config().selected) {
      // Renders any name that has a body, whatever its state: transient failures
      // keep their last-good body and `unknown` is the only state without one.
      const skill = bodies.get(skillName)
      if (skill === undefined) continue
      // Section text goes through strict {{variable}} interpolation; escape
      // {{ so unknown refs in skill bodies never throw (messages are not
      // interpolated, so start-only keeps raw content).
      blocks.push(escapePromptBraces(renderSkillContent(skill)))
    }
    return blocks.join('\n\n')
  }

  /**
   * This session's own event log. DSH >= 0.2 replaced the public `events`
   * getter with `ownEvents()`; both the deprecated `snapshotEvents()` and the
   * pre-0.2 `events` array are kept as fallbacks so dedupe keeps working across
   * the hosts this plugin can run on.
   */
  function historyEvents(agent: SessionAgent): SessionEventLike[] {
    try {
      const session = agent.session
      if (session === undefined) return []
      if (typeof session.ownEvents === 'function') return session.ownEvents() ?? []
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents() ?? []
      return Array.isArray(session.events) ? session.events : []
    } catch {
      return []
    }
  }

  /** True when the session log already carries a stamped skill-invocation for `name`. */
  function alreadyInHistory(agent: SessionAgent, skillName: string): boolean {
    try {
      return historyEvents(agent).some(
        (e) =>
          e.type === 'user/message' &&
          e.data?.source?.kind === 'skill-invocation' &&
          e.data.source.name === skillName,
      )
    } catch {
      return false
    }
  }

  // each-prompt: re-rendered into the system prompt on every assembly.
  ctx.effect(() =>
    systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => (config().mode === 'each-prompt' ? renderActiveSkills() : ''),
    }),
  )

  /**
   * Stamp the selected skills this session has not stamped yet. Idempotent:
   * `injectedByAgent` and `alreadyInHistory` make a second call after a later
   * resolve a no-op, which is what lets a cold cache stamp in two passes.
   */
  function stampSelected(agent: SessionAgent): void {
    const id = agent.id
    if (id === undefined || agent.inject === undefined) return
    const cfg = config()
    if (cfg.mode !== 'start-only') return
    const stamped = new Set(injectedByAgent.get(id) ?? [])
    for (const skillName of cfg.selected) {
      if (stamped.has(skillName)) continue
      const skill = bodies.get(skillName)
      if (skill === undefined) continue
      if (alreadyInHistory(agent, skillName)) {
        stamped.add(skillName)
        continue
      }
      try {
        agent.inject(createUserMessage(buildInjectionMessage(skillName, renderSkillContent(skill))))
        stamped.add(skillName)
      } catch {
        // contained: never let one bad stamp break the session start
      }
    }
    injectedByAgent.set(id, [...stamped])
    if (injectedByAgent.size > MAX_TRACKED_AGENTS) {
      injectedByAgent.delete(injectedByAgent.keys().next().value as string)
    }
  }

  /**
   * start-only: stamp once per selected skill, deduped against this process's
   * stamps and the session history.
   *
   * `agent/created` is a SERIAL event on DSH >= 0.2 and its listeners are
   * awaited before creation resolves, with queued input held until they finish.
   * Pass 1 stamps whatever the cache already holds; pass 2 awaits a scoped
   * resolve for a cold cache and stamps the remainder, so the injected context
   * is in the inbox before the first turn instead of racing it. A failed or
   * slow resolve is contained — session creation must never depend on it.
   */
  function onAgentCreated(agent: SessionAgent | undefined): void | Promise<void> {
    try {
      if (agent === undefined || agent.id === undefined || agent.inject === undefined) return
      remember(agent)
      stampSelected(agent)
      if (config().mode !== 'start-only') return
      return withDeadline(resolveSelection(), STAMP_RESOLVE_DEADLINE_MS)
        .then(() => {
          try {
            stampSelected(agent)
          } catch {
            // contained: a stamp failure must not fail agent creation
          }
        })
        .catch(() => {
          // contained: each await inside the pass is already contained
        })
    } catch {
      // contained: a throw here would fail agent creation
      return
    }
  }

  async function buildSnapshot(pass: ResolvePass): Promise<Snapshot> {
    let available: Array<{ name: string; description: string }> = []
    try {
      available = (await skills.list(lookupOptions()))
        .filter(isModelInvocable)
        .map((s) => ({ name: s.name, description: s.description }))
    } catch {
      available = []
    }
    // `cached` reports whether a last-good body is still held for this name: a
    // transient failure keeps injecting it, so a row is not necessarily "not
    // injecting" — `unknown` (and a first-ever failure) is.
    const unresolved: UnresolvedSkill[] = pass.rows
      .filter((r) => r.state !== 'ready')
      .map((r) => ({ ...r, cached: pass.cached.has(r.name) }))
    return {
      ok: true,
      mode: pass.mode,
      selected: pass.selected,
      available,
      unresolved,
      // ponytail: derived flat list kept one release so a stale client bundle
      // renders names instead of "[object Object]"; delete once the client shape settles.
      missing: unresolved.map((u) => u.name),
      injected: currentAgentId !== null ? (injectedByAgent.get(currentAgentId) ?? []) : [],
      canRemove: hasScopedRead,
    }
  }

  function json(res: { writeHead(s: number, h: Record<string, string>): void; end(b: string): void }, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  async function readBody(req: AsyncIterable<unknown>): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** Register a route without letting a duplicate tear down the whole entry. */
  function registerRoute(path: string, handler: Parameters<HostCtx['webServer']['register']>[0]['handler']): () => void {
    try {
      return webServer.register({ kind: 'exact', path, handler })
    } catch (e) {
      try {
        c.logger?.warn?.(`[skill-injector] could not register ${path}: ${errorText(e)}`)
      } catch {
        /* logging is best-effort */
      }
      return () => {}
    }
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // A Save touches only volatile fields, so the Loader commits it in place and
    // announces it here rather than reloading this entry. Re-resolve so the new
    // selection's bodies land before the next assembly.
    disposers.push(c.on('loader/volatile-update', () => void resolveSelection()))
    // Covers a host (or a write that also touches ordinary fields) that reloads
    // the entry's form document instead.
    disposers.push(
      c.on('settings/document-updated', (ns: string) => {
        if (ns === ENTRY_ID) void resolveSelection()
      }),
    )
    // Refresh the cache when a skill file changes on disk (the filesystem
    // provider invalidates the registry).
    disposers.push(c.on('skills/change', () => void resolveSelection()))

    // Agent lifecycle: a new agent supplies the lookup scope and the start-only
    // stamp; a disposed one must not stay the scope a lookup uses.
    disposers.push(c.on('agent/created', (payload: { agent?: SessionAgent }) => onAgentCreated(payload?.agent)))
    disposers.push(
      c.on('agent/disposed', (payload: { agent?: SessionAgent }) => {
        if (payload?.agent !== undefined && payload.agent === currentAgent) {
          currentAgent = null
          currentAgentId = null
        }
      }),
    )

    disposers.push(
      registerRoute('/skill-injector/api', async (_req, res) => {
        try {
          const pass = await resolveSelection()
          json(res, 200, await buildSnapshot(pass))
        } catch (e) {
          json(res, 500, { ok: false, error: errorText(e) })
        }
      }),
    )

    disposers.push(
      registerRoute('/skill-injector/api/config', async (req, res) => {
        try {
          const bodyText = await readBody(req)
          let parsed: unknown
          try {
            parsed = JSON.parse(bodyText)
          } catch {
            json(res, 400, { ok: false, error: 'request body must be JSON' })
            return
          }
          const r = validateSelection(parsed)
          if (!r.ok) {
            json(res, 400, { ok: false, error: r.error })
            return
          }
          // Persist into the profile patch as this entry's Config. Both fields
          // are volatile, so the Loader commits the new values into the live
          // wrappers instead of reloading the entry; echo what was validated so
          // the page can settle immediately, and warm the cache in the
          // background for the next poll.
          await settings.update(ENTRY_ID, r.config)
          void resolveSelection()
          json(res, 200, { ok: true, mode: r.config.mode, selected: r.config.selected })
        } catch (e) {
          json(res, 500, { ok: false, error: errorText(e) })
        }
      }),
    )

    void resolveSelection()

    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* best-effort teardown */
        }
      }
    }
  })
}
