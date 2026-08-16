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
  if (raw.selected.length > MAX_SELECTED) {
    return { ok: false, error: `too many skills (max ${MAX_SELECTED})` }
  }
  const selected: string[] = []
  for (const name of raw.selected) {
    if (typeof name !== 'string' || !isSkillName(name)) {
      return { ok: false, error: `invalid skill name "${String(name)}" (kebab-case required)` }
    }
    if (!selected.includes(name)) selected.push(name)
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

export { MODES }
