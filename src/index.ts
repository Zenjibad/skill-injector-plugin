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
  buildInjectionMessage,
  escapePromptBraces,
  validateSelection,
  type InjectorConfig,
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

interface Snapshot {
  ok: boolean
  error?: string
  mode: InjectorConfig['mode']
  selected: string[]
  available: Array<{ name: string; description: string }>
  missing: string[]
  injected: string[]
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

  /** name -> loaded skill body for the current selection. */
  const cache = new Map<string, SkillDef>()
  /** agentId -> skill names stamped in start-only mode. */
  const injectedByAgent = new Map<string, string[]>()
  let currentAgentId: string | null = null
  /** Live agent handle (used as the skills lookup scope) + its workspace cwd. */
  let currentAgent: { scope: unknown; cwd?: string } | null = null
  /** In-flight refresh promise so concurrent refreshCache calls share one pass. */
  let refreshInFlight: Promise<string[]> | null = null

  function refreshCache(): Promise<string[]> {
    if (refreshInFlight !== null) return refreshInFlight
    refreshInFlight = (async (): Promise<string[]> => {
      const missing: string[] = []
      const selected = config().selected
      const next = new Map<string, SkillDef>()
      for (const name of selected) {
        try {
          const skill = await skills.get(name, lookupOptions())
          if (skill === undefined || typeof skill.content !== 'string') {
            missing.push(name)
            continue
          }
          next.set(name, {
            name: skill.name,
            description: skill.description,
            content: skill.content,
            provider: skill.provider,
            ...(skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}),
          })
        } catch {
          missing.push(name)
        }
      }
      cache.clear()
      for (const [key, value] of next) cache.set(key, value)
      return missing
    })().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  /** Concatenated <skill_content> blocks for the selection (each-prompt path). */
  function renderActiveSkills(): string {
    const blocks: string[] = []
    for (const name of config().selected) {
      const skill = cache.get(name)
      if (skill === undefined) continue
      // Section text goes through strict {{variable}} interpolation; escape
      // {{ so unknown refs in skill bodies never throw (messages are not
      // interpolated, so start-only keeps raw content).
      blocks.push(escapePromptBraces(renderSkillContent(skill)))
    }
    return blocks.join('\n\n')
  }

  /** True when the session log already carries a stamped skill-invocation for `name`. */
  function alreadyInHistory(agent: { session?: { events?: Array<{ type?: string; data?: any }> } }, name: string): boolean {
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

  // start-only: stamp one durable user/message per selected skill at session
  // start, deduped against this process's stamps and the session history.
  ctx.effect(() =>
    c.on('agent/session-start', ({ agent }: { agent?: { id?: string; session?: unknown; inject?: (m: unknown) => void } }) => {
      if (agent?.id === undefined || agent.inject === undefined) return
      currentAgentId = agent.id
      currentAgent = {
        scope: agent,
        cwd: (agent as { session?: { header?: { cwd?: string } } }).session?.header?.cwd,
      }
      void refreshCache()
      if (config().mode !== 'start-only') return
      const stamped = new Set(injectedByAgent.get(agent.id) ?? [])
      for (const name of config().selected) {
        const skill = cache.get(name)
        if (skill === undefined || stamped.has(name)) continue
        if (alreadyInHistory(agent as { session?: { events?: Array<{ type?: string; data?: any }> } }, name)) {
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
      injectedByAgent.set(agent.id, [...stamped])
      if (injectedByAgent.size > 200) injectedByAgent.delete(injectedByAgent.keys().next().value as string)
    }),
  )

  async function buildSnapshot(missing: string[]): Promise<Snapshot> {
    const cfg = config()
    let available: Array<{ name: string; description: string }> = []
    try {
      available = (await skills.list(lookupOptions()))
        .filter(isModelInvocable)
        .map((s) => ({ name: s.name, description: s.description }))
    } catch {
      available = []
    }
    return {
      ok: true,
      mode: cfg.mode,
      selected: cfg.selected,
      available,
      missing,
      injected: currentAgentId !== null ? (injectedByAgent.get(currentAgentId) ?? []) : [],
    }
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // Refresh the cache when the user changes the selection or a skill file
    // changes on disk (the filesystem provider invalidates the registry).
    disposers.push(
      c.on('settings/updated', (ns: string) => {
        if (ns === NAMESPACE) void refreshCache()
      }),
    )
    disposers.push(c.on('skills/change', () => void refreshCache()))

    disposers.push(
      webServer.register({
        kind: 'exact',
        path: '/skill-injector/api',
        handler: async (_req, res) => {
          try {
            const missing = await refreshCache()
            const body = JSON.stringify(await buildSnapshot(missing))
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
            const missing = await refreshCache()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(await buildSnapshot(missing)))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }))
          }
        },
      }),
    )

    void refreshCache()

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
