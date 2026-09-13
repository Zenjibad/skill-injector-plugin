/**
 * skill-injector-plugin — host half.
 *
 * Owns the `skill-injector` settings namespace (mode + selected skills), loads
 * skill bodies from the `ctx.skills` registry, and injects them into sessions
 * two ways:
 *   - `each-prompt`: a systemPrompt.section re-rendered every assembly,
 *   - `start-only`: agent.inject() on agent/session-start (one durable
 *     user/message stamped per skill, deduped against session history).
 * Serves the snapshot to the client bundle over HTTP
 * (`GET /skill-injector/api`) and accepts selection writes
 * (`PUT /skill-injector/api/config`).
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

// Hard deps: webServer serves the routes, settings persists the selection,
// skills loads skill bodies, systemPrompt owns the each-prompt section.
export const inject = ['webServer', 'settings', 'skills', 'systemPrompt']

const NAMESPACE = 'skill-injector'
const SECTION_NAME = 'skill-injector:active'
const SECTION_ORDER = 150

interface SkillDef {
  name: string
  description: string
  content: string
  provider: string
  resourceBase?: SkillResourceBase
}

/** The subset of a live agent this plugin reads (see `agent/session-start`). */
interface SessionAgent {
  id?: string
  session?: {
    header?: { cwd?: string }
    events?: Array<{ type?: string; data?: any }>
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

type HostCtx = {
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
    register(ns: string, schema: unknown, opts: { base: InjectorConfig }): unknown
    get(ns: string): unknown
    update(ns: string, patch: Partial<InjectorConfig>): Promise<void>
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

export function apply(ctx: Context): void {
  const c = ctx as unknown as HostCtx
  const { webServer, settings, skills, systemPrompt } = c

  // Settings namespace: schema defaults + composition base (nothing selected,
  // each-prompt). A stored user section layers over the base automatically.
  const schema = z.object({
    mode: z.union([z.const('each-prompt'), z.const('start-only')]).default('each-prompt'),
    selected: z.array(z.string()).default([]),
  })
  settings.register(NAMESPACE, schema, { base: { mode: 'each-prompt', selected: [] } })

  /** Resolved, validated config; falls back to the base on any invalidity. */
  function config(): InjectorConfig {
    const raw = settings.get(NAMESPACE)
    const r = validateSelection(raw ?? {})
    return r.ok ? r.config : { mode: 'each-prompt', selected: [] }
  }

  /** Skill lookups MUST use the live agent's scope: the filesystem provider
   * registers in the agent preset's layer, so a host-global lookup is empty. */
  function lookupOptions(): { scope: unknown; cwd?: string } | undefined {
    if (currentAgent === null) return undefined
    return currentAgent.cwd !== undefined
      ? { scope: currentAgent.scope, cwd: currentAgent.cwd }
      : { scope: currentAgent.scope }
  }

  /** name -> last-good skill body. Replaced only on `ready`; see applyBodies. */
  let bodies = new Map<string, SkillDef>()
  /** True once a pass ran with an agent scope; gates the UI's Remove action. */
  let hasScopedRead = false
  /** agentId -> skill names stamped in start-only mode. */
  const injectedByAgent = new Map<string, string[]>()
  let currentAgentId: string | null = null
  /** Live agent handle (used as the skills lookup scope) + its workspace cwd. */
  let currentAgent: { scope: unknown; cwd?: string } | null = null
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
    const cfg = config()
    const options = lookupOptions()
    const key = (options !== undefined ? 'scoped:' : 'unscoped:') + cfg.selected.join(',')
    if (refreshInFlight !== null && refreshInFlight.key === key) return refreshInFlight.promise
    const seq = ++passSeq
    const promise = (async (): Promise<ResolvePass> => {
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
      for (const name of cfg.selected) {
        if (!advertised.has(name)) continue
        try {
          const skill = await skills.get(name, options)
          if (skill === undefined || typeof skill.content !== 'string') {
            loads.set(name, { ok: false, reason: 'skill body could not be loaded' })
            continue
          }
          fresh.set(name, {
            name: skill.name,
            description: skill.description,
            content: skill.content,
            provider: skill.provider,
            ...(skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}),
          })
          loads.set(name, { ok: true })
        } catch (e) {
          loads.set(name, { ok: false, reason: errorText(e) })
        }
      }

      const rows = classifySelection({ selected: cfg.selected, catalog, scoped, loads })
      // Compute this pass's body map even when a newer pass already superseded it,
      // so `cached` always describes the rows it is returned with. Only the newest
      // pass may publish it.
      const nextBodies = applyBodies(bodies, rows, fresh)
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
    for (const name of config().selected) {
      // Renders any name that has a body, whatever its state: transient failures
      // keep their last-good body and `unknown` is the only state without one.
      const skill = bodies.get(name)
      if (skill === undefined) continue
      // Section text goes through strict {{variable}} interpolation; escape
      // {{ so unknown refs in skill bodies never throw (messages are not
      // interpolated, so start-only keeps raw content).
      blocks.push(escapePromptBraces(renderSkillContent(skill)))
    }
    return blocks.join('\n\n')
  }

  /** True when the session log already carries a stamped skill-invocation for `name`. */
  function alreadyInHistory(agent: SessionAgent, name: string): boolean {
    try {
      const events = agent.session?.events
      if (!Array.isArray(events)) return false
      return events.some(
        (e) =>
          e.type === 'user/message' &&
          e.data?.source?.kind === 'skill-invocation' &&
          e.data.source.name === name,
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
    if (config().mode !== 'start-only') return
    const stamped = new Set(injectedByAgent.get(id) ?? [])
    for (const name of config().selected) {
      if (stamped.has(name)) continue
      const skill = bodies.get(name)
      if (skill === undefined) continue
      if (alreadyInHistory(agent, name)) {
        stamped.add(name)
        continue
      }
      try {
        agent.inject(createUserMessage(buildInjectionMessage(name, renderSkillContent(skill))))
        stamped.add(name)
      } catch {
        // contained: never let one bad stamp break the session start
      }
    }
    injectedByAgent.set(id, [...stamped])
    if (injectedByAgent.size > 200) injectedByAgent.delete(injectedByAgent.keys().next().value as string)
  }

  // start-only: stamp once per selected skill, deduped against this process's
  // stamps and the session history.
  ctx.effect(() =>
    c.on('agent/session-start', ({ agent }: { agent?: SessionAgent }) => {
      if (agent?.id === undefined || agent.inject === undefined) return
      currentAgentId = agent.id
      currentAgent = { scope: agent, cwd: agent.session?.header?.cwd }
      // Pass 1: whatever the cache already holds, synchronously (warm path).
      stampSelected(agent)
      // Pass 2: a fresh process has a cold cache, so resolve scoped first and
      // stamp the remainder. The emit is not awaited, so this lands a task
      // later — before the first prompt assembly in practice, and the same
      // shape dsh-hooks-codex uses for its SessionStart work.
      void resolveSelection()
        .then(() => stampSelected(agent))
        .catch(() => {
          // defensive: each await inside the pass is already contained
        })
    }),
  )

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

  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // Refresh the cache when the user changes the selection or a skill file
    // changes on disk (the filesystem provider invalidates the registry).
    disposers.push(
      c.on('settings/updated', (ns: string) => {
        if (ns === NAMESPACE) void resolveSelection()
      }),
    )
    disposers.push(c.on('skills/change', () => void resolveSelection()))

    disposers.push(
      webServer.register({
        kind: 'exact',
        path: '/skill-injector/api',
        handler: async (_req, res) => {
          try {
            const pass = await resolveSelection()
            const body = JSON.stringify(await buildSnapshot(pass))
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(body)
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }))
          }
        },
      }),
    )

    disposers.push(
      webServer.register({
        kind: 'exact',
        path: '/skill-injector/api/config',
        handler: async (req, res) => {
          try {
            const chunks: Buffer[] = []
            for await (const chunk of req) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
            }
            const bodyText = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown
            try {
              parsed = JSON.parse(bodyText)
            } catch {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'request body must be JSON' }))
              return
            }
            const r = validateSelection(parsed)
            if (!r.ok) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: r.error }))
              return
            }
            await settings.update(NAMESPACE, r.config)
            const pass = await resolveSelection()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(await buildSnapshot(pass)))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }))
          }
        },
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
