# AGENTS.md — Guide for AI agents

This file helps AI coding agents and LLM tooling understand and work with this repository quickly.

## What this repo is

`skill-injector-plugin` is a **packaged Cordis plugin for DeepSeek Harness (DSH)** that auto-injects user-chosen skills (e.g. `caveman`, `ponytail`) into sessions — either every prompt (`each-prompt` via a `systemPrompt.section`) or once at session start (`start-only` via `agent.inject()` on `agent/created`) — with a settings page and a composer dock line. It is a real profile-bundled plugin: `dsh.bundle` (`cordis.patch.yml`) mounts the host half, and the `dsh.client` declaration + `exports["./client"]` register the browser half — install once with `dsh plugin add`, loads on every DSH boot, no cordis_define. The host half declares its settings as the plugin's Loader **Config** (`mode` + `selected` + `showDock`), reads skill bodies from the live `ctx.skills` registry, and serves the snapshot over `GET /skill-injector/api` (plus `PUT /skill-injector/api/config` for writes); the client half polls every 5s and renders a `settings.section` form and a `conversation.composer.dock` line. The client↔host seam is **HTTP only** — there is no `harness.handle`/`host.call` RPC for packaged plugins.

Targets **DSH 0.2.x** (`^0.2.1-rc.5` for `@deepseek-ai/dsh-skill` / `dsh-llm`, `@deepseek-ai/cordis` `^4.0.5`).

## Repository layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Host half: exported `Config` (schemastery, all three fields `.volatile()`), `resolveSelection` (catalog snapshot + per-name classification) publishing a last-good body map, `systemPrompt.section` (each-prompt, order 150) + two-pass `agent/created` injection (start-only, deduped), `webServer` routes `GET /skill-injector/api` + `PUT /skill-injector/api/config`. |
| `src/helpers.ts` | Pure helpers (separate build entry for unit testing): `validateSelection`, `escapePromptBraces`, `buildInjectionMessage`, `classifySelection`, `applyBodies`, `cachedSuffix`, `isSkillName`, `MAX_SELECTED`, types. |
| `src/client/index.tsx` | Client bundle: single 5s poller `fetch('/skill-injector/api')`, `settings.section` id `skill-injector` (order 60; unresolved rows with per-skill Retry + Remove), `conversation.composer.dock` id `skill-injector-dock` (order 10). |
| `cordis.patch.yml` | `dsh.bundle.patch`: inserts the plugin row `{id: skill-injector-plugin, name: 'skill-injector-plugin'}`. |
| `tsdown.config.ts` | Builds host (node ESM → `lib/index.js`), helpers (node ESM → `lib/helpers.js`), client (browser CJS ModuleLoader closure → `lib/client.js`, bundle id = package name). |
| `package.json` | `exports["./client"]`, `dsh.bundle.patch`, `dsh.client` (`platform: 'web'`, `inject: []`), peers react + @deepseek-ai/cordis, deps @deepseek-ai/dsh-llm + dsh-skill + schemastery. |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted` (Windows junctions break tsdown's transitive resolution under the stricter layout) + `allowBuilds: { esbuild: false }`. |
| `tests/helpers.test.mjs` | node:test unit tests against `lib/helpers.js` (32 tests), including `classifySelection`, `applyBodies`, and `cachedSuffix`. |
| `tests/host.test.mjs` | node:test smoke tests (10) driving `apply()` with a stub Cordis context: the Config contract, resolve states, last-good retention through the rendered section, the `canRemove` scope gate, cold-cache stamping and dedupe, the scope-transition pass key, the live-config Save path, lazy scope recovery, the `PUT` config route, and brace escaping. |
| `tests/fixtures/sample-skill.json` | Real-shape skill definition as `ctx.skills.get` returns it. |
| `README.md` / `README.zh.md` | Human docs (en default, zh). |
| `llms.txt` / `llms-full.txt` | LLM-friendly doc index / full text. |

## Key behaviors (don't break these)

1. **Packaged, not dynamic**: install via `dsh plugin add` (or profile `link:` dep + restart). Do NOT revert to a dynamic `cordis_define`-only shape.
2. **Client talks to host over HTTP only**: the client bundle polls `/skill-injector/api` and PUTs `/skill-injector/api/config` (host `webServer` routes). Do not reintroduce the dynamic `harness.handle`/`host.call` seam — it does not exist for packaged plugins.
3. **Settings are the plugin's Loader Config, and all three fields MUST stay `.volatile()`**:
   - `export const Config = z.object({ mode: …, selected: …, showDock: … })`; the Loader validates it through cordis's Standard-Schema probe and hands the result to `apply(ctx, config)`.
   - Volatile output is a **reference with `.get()`**, not a plain value: always read through `readLive(...)`/`config()` so a Save is visible immediately.
   - `ctx.settings.update(entryId, patch)` **refuses a non-volatile field** (`volatileForm`/`isVolatilePath` in `dsh-settings`), and the Loader only commits a volatile-only change **in place** (it swaps the references and emits `loader/volatile-update`) instead of reloading the entry. Dropping `.volatile()` breaks Save in two ways at once.
   - `entryId` is the profile patch row id, resolved from `ctx.get('loader').entries()` by `options.name === 'skill-injector-plugin'`, falling back to the package name.
   - The bundle ships its own settings page, so `apply` calls `settings.configure({ auto: false })` (guarded — newer than the Config model itself) to suppress the schema-generated duplicate page.
4. **Read skill bodies from `ctx.skills`, never copy skill files**: `resolveSelection` reads the catalog once via `skills.snapshot(options)` (which reports discovery `complete`), loads bodies via `skills.get(name, options)` only for names the catalog advertises, and keeps last-good bodies in an in-process `Map` (`applyBodies` replaces a body only on `ready`). Every selected name is classified as `ready` / `unknown` / `unavailable` / `load-failed` / `no-scope` and reported in the snapshot's `unresolved` array with a reason. Do not bundle skill content into the repo or cache it across restarts.
   - **Skill lookups MUST use the live agent's scope**: `@deepseek-ai/dsh-skill-filesystem` registers in the agent preset's layer (row `skill-filesystem` in `agent.cordis.yml`), NOT the host global layer. A host-scope `ctx.skills.list({})`/`get(name, {})` returns empty. Use `{ scope: <agent>, cwd: agent.session.header.cwd }`; `scope` is a `ScopeKey` (an opaque object) and the agent loop mints its scope **keyed by the agent object itself** (`createScope(loopCtx, this)`), which is why passing the agent works. Do not revert to scopeless lookups.
5. **`escapePromptBraces` ONLY in the section path**: the `each-prompt` section escapes `{{` in skill bodies (`renderActiveSkills` → `escapePromptBraces(renderSkillContent(...))`) because section text goes through strict `{{variable}}` interpolation; `start-only` messages are NOT interpolated and must keep raw content (`buildInjectionMessage(name, renderSkillContent(skill))`). `renderSkillContent` needs `name`, `provider`, `resourceBase`, and `content` — pass the loaded `SkillDefinition`, do not invent a partial object.
6. **Dedupe start-only stamps against the session log, and stamp in two passes**: `alreadyInHistory` scans this session's events for `user/message` events with `data.source.kind === 'skill-invocation'` and `data.source.name`; combined with the in-process `injectedByAgent` set so resumes/restarts never double-stamp. `historyEvents` prefers `session.ownEvents()` (DSH 0.2) and falls back to `snapshotEvents()` then the pre-0.2 `session.events` array. `stampSelected` runs twice per `agent/created` — synchronously for a warm cache, then again after the resolve for a cold one (a fresh process has an empty cache, so one pass would silently stamp nothing).
   - `agent/created` is **serial** and awaited before creation resolves, with queued input held until listeners finish — so it is the correct place to `agent.inject(...)` for start-only. Pass 2 therefore **awaits** the resolve, bounded by `withDeadline(..., STAMP_RESOLVE_DEADLINE_MS)`; never let a slow or failing resolve block or fail session creation.
7. **Routes always return `{ok:false,error}` JSON**: both routes write JSON on every path (200 success, 400 invalid body/config, 500 unexpected) — never a non-JSON 500. The `PUT` config route validates via `validateSelection` before `settings.update`, then echoes the validated values and warms the cache in the background. Keep the `config` route validating and use `registerRoute`, which contains a duplicate-registration failure instead of letting a throw tear down the whole entry.
8. **`resolveSelection` is deduped (in-flight memo)**: concurrent calls share one pass via `refreshInFlight` (cleared in `.finally`) — do not remove; it prevents stampede resolves from `loader/volatile-update`, `skills/change`, the 5s poll, and the Retry button. The memo is keyed on scope-ness + selection (`scoped:`/`unscoped:` plus the selected names), so a newly arrived scope deliberately starts a fresh pass instead of joining an older one — joining an older pass is what host test 5 pins against. The monotonic `passSeq` guard keeps a late-settling pass from committing bodies over a newer one.
9. **`injectedByAgent` is capped at 200**: entries are evicted oldest-first — do not remove; it bounds memory across sessions.
10. **`unknown` is the only final failure, and `canRemove` gates the UI**: only a complete, *scoped* catalog read that does not advertise a name may produce `unknown` (safe to drop). An incomplete catalog yields `unavailable`, and an unscoped read yields `no-scope` — never `unknown`. The snapshot's `canRemove` is true only after a scoped resolve has run, so a client can never delete a good selection during the boot race.
11. **Scope survives a reload**: the plugin can still be re-applied (a non-volatile config edit, an HMR rebuild, a loader reload). The fresh instance starts with no scope, so `lookupOptions()` falls back to `ctx.get('agents').list()` (the last live agent) and `agent/disposed` clears a remembered one. Never resolve against a dead scope: that reports every agent-preset skill as `unknown` and drops its body.

## Common tasks

- **Change poll interval**: `POLL_MS = 5000` in `src/client/index.tsx`. Keep the Client using one interval.
- **Add a settings field**: add it to `Config` in `src/index.ts` as `.volatile()` (required for `settings.update`), read it through `config()`, add it to the client form, and extend `tests/host.test.mjs` (the first test asserts the field is volatile).
- **Add an injection mode**: extend `Config.mode` (union in `src/index.ts`) + `MODES` in `src/helpers.ts`, the host branch (section vs agent-created), the client radio (`si-modes`), and the tests in `tests/helpers.test.mjs`.
- **Rebuild**: `pnpm install && pnpm build` (outputs `lib/index.js` + `lib/helpers.js` + `lib/client.js`), then `pnpm typecheck`.
- **Update the live profile install**: rebuild, then restart DSH (host-half changes need restart; client changes hot-reload only for already-mounted bundles — a changed `lib/client.js` is re-hashed and re-served).

## Environment facts (probed, do not re-probe)

- **Packaged host plugins are real Node modules** (`cordis-plugin-loader` uses plain `import()`): `process.env`, `Date`, `Buffer`, `setTimeout`, and async iteration over `req` ARE available — unlike the dynamic-plugin sandbox. No cmd env-probe needed.
- `webServer.register` route shape: `{kind: 'exact'|'prefix', path, handler(req, res)}` with node:http semantics; duplicate (kind, path) throws. Register inside `ctx.effect(() => …)` and RETURN the disposer.
- The client bundle is plain browser JS (ModuleLoader CJS factory): `fetch`, `setInterval`, `document` are available; React comes from the module table (`external: react`), `React.createElement` only — no JSX.
- Host event contracts (0.2.x): `agent/created` is **serial**, payload `{ agent, source, signal? }`, awaited before creation resolves; `agent/disposed` payload `{ agent }`; `agent.id` is the session id; `agent.inject(message)` queues model-facing context for the next pre-step; `settings/document-updated` fires with `(ns, revision)`; `loader/volatile-update` fires with the changed paths after an in-place config commit; `skills/change` fires when the registry invalidates.
- `agent/session-start` and `settings/updated` **do not exist** on 0.2.x — they were replaced by `agent/created` and `settings/document-updated`.
- `agent.session.ownEvents()` is the non-deprecated session-log read (`eventAt`/`snapshotEvents` are deprecated for new calls); `agent.session.header.cwd` still carries the workspace cwd.
- `renderSkillContent` (canonical `<skill_content>` block) comes from `@deepseek-ai/dsh-skill`; `createUserMessage` comes from `@deepseek-ai/dsh-llm`; the `skill-invocation` message source is declared by `dsh-skill` via module augmentation of `dsh-llm`'s `MessageSourceMap`.
- Skill lookups need the agent scope (see Key behaviors): the plugin remembers the agent from `agent/created`, or recovers the last live agent from `ctx.get('agents').list()`. Before any agent exists the route reports `available: []`, every selected name unresolved (`no-scope`: an unscoped read can never be `unknown`), and `canRemove: false`.
- `ctx.skills.snapshot(options)` returns `{ skills, complete }`; `list()` is implemented as `(await snapshot(options)).skills`. `complete: false` means discovery did not finish — retain last-good state and retry at the next boundary, never treat it as a deletion.
- Optional services are read with `ctx.get(name)` (no `inject` edge): `loader` (entry id) and `agents` (scope recovery). Only hard requirements belong in `inject`.

## DSH 0.1 → 0.2 migration notes (what changed, and why this plugin looks like this)

| 0.1.x | 0.2.x |
| --- | --- |
| `settings.register(ns, schema, { base })` + `settings.get(ns)` | export `Config`; Loader passes it to `apply(ctx, config)`; fields must be `.volatile()`; reads via `.get()` |
| `settings.update(ns, patch)` into a user section | `settings.update(entryId, patch)` merges into the profile patch's entry config |
| `settings/updated` | `settings/document-updated` (+ `loader/volatile-update` for in-place volatile commits) |
| `agent/session-start` (emit, not awaited) | `agent/created` (serial, awaited, payload `{ agent, source }`) |
| `agent.session.events` | `agent.session.ownEvents()` |
| `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"]` | both packages were removed; our bundle only requires `react` (a module-table seed) and the `slots` service, so the list is `[]` |
| peers on `dsh-client-runtime` / `dsh-client-ui-slots` | dropped; peers are `react` + `@deepseek-ai/cordis` |

## Testing

- **Before restart**: verify the profile installed the bundle — `~/.dsh/profiles/<name>/package.json` `dependencies` and `dsh.profile.bundles` both list `skill-injector-plugin`; `lib/client.js` has the ModuleLoader wrapper (`id: "skill-injector-plugin"`) and `inject = ["slots"]`; `lib/index.js` exports `name` + `Config` + `inject` + `apply`.
- **After restart**: `GET /skill-injector/api` (in the browser, same origin) returns `{ok:true, mode, selected, showDock, available, unresolved, missing, injected, canRemove}`; Settings → Skill Injector toggles + Save (the save must take effect on the next prompt without a restart), and each unresolved row shows a reason with Retry (plus Remove once `canRemove`); `each-prompt` affects the next reply; `start-only` stamps once per session, on the first session of a fresh process too, and a resume after restart does not double-stamp; a deleted skill reports `unknown` and the rest keep injecting.
- Unit tests: `node --test --test-isolation=none "tests/**/*.mjs"` after `pnpm build` — 42 tests (`helpers.test.mjs` 32 against `lib/helpers.js`, `host.test.mjs` 10 driving `apply()` with a stub ctx). Use that in-process form under a confined shell, where `node --test tests/` (what `pnpm test` runs, canonical outside a confined shell) dies with `spawn EPERM` spawning a child per test file.
- Two invariants the unit suite cannot see, worth re-checking by hand after a DSH bump: (a) `lib/index.js`'s `createUserMessage(buildInjectionMessage(...))` result still passes the host's `validateSessionEventData`; (b) `dsh-settings`' `volatileForm`/`isVolatilePath` still accept a `{mode, selected, showDock}` patch.

## Notes for LLM crawlers

- Listed under the GitHub topic `dsh-plugin`; packaged profile plugin for DeepSeek Harness (targets 0.2.x).
- Distinguishing traits: packaged (persists across restarts), live `ctx.skills` registry (no copied skill files), two injection modes (each-prompt section vs start-only stamped message), subagents included (no filtering), HTTP-only client↔host seam (`/skill-injector/api`), settings as a volatile Loader `Config`.
