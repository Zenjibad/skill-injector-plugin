/**
 * skill-injector-plugin — client half (browser bundle).
 *
 * Polls the host's `/skill-injector/api` route every 5s and renders into two
 * DSH seats:
 *   - settings.section (id `skill-injector`) — checkbox list + mode radio + save
 *   - conversation.composer.dock (id `skill-injector-dock`) — active-skills line
 *
 * Ships as exports["./client"] (CJS ModuleLoader factory), discovered via the
 * dsh.client declaration in package.json. Client talks to host over HTTP only.
 */
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['slots']

const POLL_MS = 5000
const API = '/skill-injector/api'
const API_CONFIG = '/skill-injector/api/config'

interface AvailableSkill {
  name: string
  description: string
}

interface Snapshot {
  ok: boolean
  error?: string
  mode: 'each-prompt' | 'start-only'
  selected: string[]
  available: AvailableSkill[]
  missing: string[]
  injected: string[]
}

export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as
    | {
        inject(name: string, callback: () => () => void): void
        register(
          options: { name: string; id: string; order?: number; label?: string },
          component: (props: unknown) => React.ReactNode,
        ): () => void
      }
    | undefined
  if (slots === undefined) return

  const style = document.createElement('style')
  style.dataset.plugin = 'skill-injector-plugin'
  style.textContent = [
    '.si-dash{display:flex;flex-direction:column;gap:14px;padding:8px 0;color:var(--dsw-alias-label-primary)}',
    '.si-title{font-size:16px;font-weight:600}',
    '.si-sub{font-size:12px;opacity:.55}',
    '.si-list{display:flex;flex-direction:column;gap:4px}',
    '.si-item{display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
    '.si-item input{margin-top:2px}',
    '.si-item-name{font-size:13px;font-weight:600}',
    '.si-item-desc{font-size:12px;opacity:.6}',
    '.si-modes{display:flex;gap:16px;font-size:13px}',
    '.si-modes label{display:flex;gap:6px;align-items:center}',
    '.si-save{padding:6px 16px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}',
    '.si-status{font-size:12px;opacity:.7}',
    '.si-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
    '.si-note{padding:16px;opacity:.7}',
    '.si-dock{font-size:12px;opacity:.65;padding:2px 0}',
  ].join('')
  document.head.appendChild(style)
  ctx.effect(() => () => {
    style.remove()
  })

  let snapshot: Snapshot | null = null
  const listeners = new Set<() => void>()

  async function poll(): Promise<void> {
    try {
      const res = await fetch(API, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      snapshot = (await res.json()) as Snapshot
    } catch (e) {
      snapshot = { ok: false, error: String((e as Error)?.message ?? e), mode: 'each-prompt', selected: [], available: [], missing: [], injected: [] }
    }
    for (const fn of listeners) fn()
  }
  void poll()
  const timer = setInterval(() => void poll(), POLL_MS)
  ctx.effect(() => () => {
    clearInterval(timer)
    listeners.clear()
  })

  function useSnapshot(): Snapshot | null {
    const [state, setState] = React.useState<Snapshot | null>(snapshot)
    React.useEffect(() => {
      const fn = () => setState(snapshot)
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }, [])
    return state
  }

  function SettingsPanel(): React.ReactElement | null {
    const snap = useSnapshot()
    const h = React.createElement
    const [selected, setSelected] = React.useState<string[]>(snap?.selected ?? [])
    const [mode, setMode] = React.useState<'each-prompt' | 'start-only'>(snap?.mode ?? 'each-prompt')
    const [saving, setSaving] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [saved, setSaved] = React.useState(false)

    // Keep local state in sync when a poll brings a newer selection.
    React.useEffect(() => {
      if (snap === null) return
      setSelected(snap.selected)
      setMode(snap.mode)
    }, [snap?.mode, JSON.stringify(snap?.selected)])

    function toggle(name: string, checked: boolean): void {
      setSaved(false)
      setSelected((prev) => (checked ? [...prev, name] : prev.filter((n) => n !== name)))
    }

    async function save(): Promise<void> {
      setSaving(true)
      setError(null)
      try {
        const res = await fetch(API_CONFIG, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode, selected }),
        })
        const body = (await res.json()) as { ok: boolean; error?: string }
        if (!body.ok) throw new Error(body.error ?? 'HTTP ' + res.status)
        setSaved(true)
        void poll()
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      } finally {
        setSaving(false)
      }
    }

    if (snap === null) return h('div', { className: 'si-note' }, 'Loading skills…')
    if (!snap.ok) return h('div', { className: 'si-note si-error' }, 'Skill Injector unavailable: ' + String(snap.error))

    return h(
      'div',
      { className: 'si-dash' },
      h('div', { className: 'si-title' }, 'Skill Injector'),
      h('div', { className: 'si-sub' }, 'Inject chosen skills into every session. Choose skills and mode, then Save.'),
      h(
        'div',
        { className: 'si-list' },
        snap.available.map((skill) =>
          h(
            'label',
            { key: skill.name, className: 'si-item' },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(skill.name),
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => toggle(skill.name, e.target.checked),
            }),
            h(
              'div',
              null,
              h('div', { className: 'si-item-name' }, skill.name),
              h('div', { className: 'si-item-desc' }, skill.description),
            ),
          ),
        ),
      ),
      snap.missing.length > 0
        ? h('div', { className: 'si-error' }, 'Missing skills (deleted or unknown): ' + snap.missing.join(', '))
        : null,
      h(
        'div',
        { className: 'si-modes' },
        h('label', null, h('input', { type: 'radio', name: 'si-mode', checked: mode === 'each-prompt', onChange: () => setMode('each-prompt') }), 'Inject every prompt'),
        h('label', null, h('input', { type: 'radio', name: 'si-mode', checked: mode === 'start-only', onChange: () => setMode('start-only') }), 'Inject once at session start'),
      ),
      h('button', { className: 'si-save', onClick: () => void save(), disabled: saving }, saving ? 'Saving…' : 'Save'),
      error !== null ? h('div', { className: 'si-error' }, error) : null,
      saved ? h('div', { className: 'si-status' }, 'Saved') : null,
      h(
        'div',
        { className: 'si-status' },
        'Active in this session: ' + (snap.injected.length > 0 ? snap.injected.join(', ') : 'none'),
      ),
    )
  }

  function DockLine(): React.ReactElement | null {
    const snap = useSnapshot()
    if (snap === null || !snap.ok) return null
    const names = snap.selected.length > 0 ? snap.selected.join(', ') : 'none'
    return React.createElement(
      'div',
      { className: 'si-dock' },
      'Injected Skills: ' + names + ' · Mode: ' + snap.mode,
    )
  }

  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'skill-injector', order: 60, label: 'Skill Injector' },
      () => React.createElement(SettingsPanel),
    ),
  )
  slots.inject('conversation.composer.dock', () =>
    slots.register(
      { name: 'conversation.composer.dock', id: 'skill-injector-dock', order: 10 },
      () => React.createElement(DockLine),
    ),
  )
}
