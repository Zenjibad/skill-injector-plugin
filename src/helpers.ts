/** Injection modes. */
export type InjectMode = 'each-prompt' | 'start-only'

/** The settings value shape for the skill-injector namespace. */
export interface InjectorConfig {
  mode: InjectMode
  selected: string[]
}

/** Prompt-bloat guard: at most this many skills can be selected. */
export const MAX_SELECTED = 16

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MODES: readonly InjectMode[] = ['each-prompt', 'start-only']

/** Return whether a string is a valid kebab-case skill name. */
export function isSkillName(value: string): boolean {
  return SKILL_NAME.test(value)
}

/**
 * Validate a candidate settings value (e.g. a PUT body or stored settings) into
 * a normalized InjectorConfig. Rejects non-objects, unknown modes, non-kebab
 * names, duplicate names (deduped), and selections over MAX_SELECTED.
 */
export function validateSelection(
  value: unknown,
): { ok: true; config: InjectorConfig } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'settings must be an object { mode, selected }' }
  }
  const raw = value as Record<string, unknown>
  const mode = raw.mode
  if (mode !== 'each-prompt' && mode !== 'start-only') {
    return { ok: false, error: 'mode must be "each-prompt" or "start-only"' }
  }
  if (!Array.isArray(raw.selected)) {
    return { ok: false, error: 'selected must be an array of skill names' }
  }
  const selected: string[] = []
  for (const name of raw.selected) {
    if (typeof name !== 'string' || !isSkillName(name)) {
      return { ok: false, error: `invalid skill name "${String(name)}" (kebab-case required)` }
    }
    if (!selected.includes(name)) selected.push(name)
  }
  if (selected.length > MAX_SELECTED) {
    return { ok: false, error: `too many skills (max ${MAX_SELECTED})` }
  }
  return { ok: true, config: { mode, selected } }
}

/**
 * Escape `{{` so system-prompt strict variable interpolation never throws on
 * unknown `{{variable}}` references inside injected skill bodies. Only the
 * section (system-prompt) path needs this; injected user messages are not
 * interpolated.
 */
export function escapePromptBraces(text: string): string {
  return text.replaceAll('{{', '&#123;&#123;')
}

/**
 * Build the model-facing user-message payload for one skill injection:
 * `{ content, source }` — the exact shape `createUserMessage` (from
 * `@deepseek-ai/dsh-llm`) accepts, matching the user-explicit skill-invocation
 * path in dsh-tool-skill.
 */
export function buildInjectionMessage(name: string, renderedText: string): {
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'skill-invocation'; name: string; form: 'instructions' }
} {
  return {
    content: [{ type: 'text', text: renderedText }],
    source: { kind: 'skill-invocation', name, form: 'instructions' },
  }
}

/** How one selected skill name resolved against the current catalog. */
export type SkillState = 'ready' | 'unknown' | 'unavailable' | 'load-failed' | 'no-scope'

/** One classified selection row. `reason` is set unless the state is `ready`. */
export interface ClassifiedSkill {
  name: string
  state: SkillState
  reason?: string
}

/** A catalog observation, or the failure that prevented one. */
export type CatalogObservation =
  | { kind: 'scoped'; names: readonly string[]; complete: boolean }
  | { kind: 'error'; reason: string }

/** Body-load outcome for a name the catalog advertises. */
export type LoadOutcome = { ok: true } | { ok: false; reason?: string }

/**
 * Classify every selected name against one catalog observation, in selection
 * order. An incomplete catalog can never yield `unknown` (the name may simply not
 * be discovered yet) and neither can an unscoped read (the agent preset's
 * provider layer is invisible without a scope), so `unknown` always means
 * "complete discovery, scoped read, genuinely absent".
 */
export function classifySelection(input: {
  selected: readonly string[]
  catalog: CatalogObservation
  scoped: boolean
  loads: ReadonlyMap<string, LoadOutcome>
}): ClassifiedSkill[] {
  const { selected, catalog, scoped, loads } = input
  const advertised = new Set(catalog.kind === 'scoped' ? catalog.names : [])
  const complete = catalog.kind === 'scoped' && catalog.complete
  return selected.map((name) => {
    if (advertised.has(name)) {
      const load = loads.get(name)
      if (load !== undefined && load.ok) return { name, state: 'ready' }
      return {
        name,
        state: 'load-failed',
        // An empty message is no reason at all; `||` (not `??`) so the UI never shows a blank row.
        reason: load?.reason || 'skill body could not be loaded',
      }
    }
    if (catalog.kind === 'error') {
      return { name, state: 'unavailable', reason: catalog.reason || 'skill catalog read failed' }
    }
    if (!complete) return { name, state: 'unavailable', reason: 'provider discovery incomplete' }
    if (!scoped) return { name, state: 'no-scope', reason: 'waiting for a session to establish scope' }
    return { name, state: 'unknown', reason: 'not in the skill catalog' }
  })
}

/**
 * Apply one classification pass to the last-good body map: `ready` replaces a
 * body, `unknown` and deselected names drop theirs, and transient states keep
 * whatever was cached before, so a provider hiccup never removes a skill from the
 * prompt. Generic over the body type to stay free of registry types.
 */
export function applyBodies<T>(
  prev: ReadonlyMap<string, T>,
  rows: readonly ClassifiedSkill[],
  fresh: ReadonlyMap<string, T>,
): Map<string, T> {
  const next = new Map<string, T>()
  for (const row of rows) {
    if (row.state === 'unknown') continue
    const body = row.state === 'ready' ? fresh.get(row.name) : prev.get(row.name)
    if (body !== undefined) next.set(row.name, body)
  }
  return next
}

/**
 * What a held body means for the prompt depends on the mode: `each-prompt`
 * re-renders the section every request, while `start-only` only injects at
 * session start. Returns the trailing hint for one unresolved row, or '' when
 * the row has no last-good body to talk about.
 */
export function cachedSuffix(input: {
  mode: InjectMode
  injected: readonly string[]
  name: string
  cached: boolean | undefined
}): string {
  if (input.cached !== true) return ''
  if (input.mode === 'start-only') {
    return input.injected.includes(input.name) ? ' · already in this session' : ' · last loaded copy retained'
  }
  return ' · still injecting the last loaded copy'
}

export { MODES }
