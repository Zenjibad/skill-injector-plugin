# AGENTS.md — Guide for AI agents

This file helps AI coding agents and LLM tooling understand and work with this repository quickly.

## What this repo is

`skill-injector-plugin` is a **packaged Cordis plugin for DeepSeek Harness (DSH)** that auto-injects user-chosen skills (e.g. `caveman`, `ponytail`) into sessions — either every prompt (`each-prompt` via a `systemPrompt.section`) or once at session start (`start-only` via `agent.inject()` on `agent/session-start`) — with a settings page and a composer dock line. It is a real profile-bundled plugin: `dsh.bundle` (`cordis.patch.yml`) mounts the host half, and the `dsh.client` declaration + `exports["./client"]` register the browser half — install once with `dsh plugin add`, loads on every DSH boot, no cordis_define. The host half owns a `skill-injector` settings namespace (`mode` + `selected`), reads skill bodies from the live `ctx.skills` registry, and serves the snapshot over `GET /skill-injector/api` (plus `PUT /skill-injector/api/config` for writes); the client half polls every 5s and renders a `settings.section` form and a `conversation.composer.dock` line. The client↔host seam is **HTTP only** — there is no `harness.handle`/`host.call` RPC for packaged plugins.

## Repository layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Host half: `skill-injector` settings namespace (schemastery schema + base), `resolveSelection` (catalog snapshot + per-name classification) publishing a last-good body map, `systemPrompt.section` (each-prompt, order 150) + two-pass `agent/session-start` injection (start-only, deduped), `webServer` routes `GET /skill-injector/api` + `PUT /skill-injector/api/config`. |
| `src/helpers.ts` | Pure helpers (separate build entry for unit testing): `validateSelection`, `escapePromptBraces`, `buildInjectionMessage`, `classifySelection`, `applyBodies`, `cachedSuffix`, `isSkillName`, `MAX_SELECTED`, types. |
| `src/client/index.tsx` | Client bundle: single 5s poller `fetch('/skill-injector/api')`, `settings.section` id `skill-injector` (order 60; unresolved rows with per-skill Retry + Remove), `conversation.composer.dock` id `skill-injector-dock` (order 10). |
| `cordis.patch.yml` | `dsh.bundle.patch`: inserts the plugin row `{id: skill-injector-plugin, name: 'skill-injector-plugin'}`. |
| `tsdown.config.ts` | Builds host (node ESM → `lib/index.js`), helpers (node ESM → `lib/helpers.js`), client (browser CJS ModuleLoader closure → `lib/client.js`, bundle id = package name). |
| `package.json` | `exports["./client"]`, `dsh.bundle.patch`, `dsh.client` (`platform: 'web'`, inject edges), peers react + @deepseek-ai/cordis + client runtime/slots, deps @deepseek-ai/dsh-llm + dsh-skill + schemastery. |
| `tests/helpers.test.mjs` | node:test unit tests against `lib/helpers.js` (30 tests), including `classifySelection`, `applyBodies`, and `cachedSuffix`. |
| `tests/host.test.mjs` | node:test smoke test (7 tests) driving `apply()` with a stub Cordis context: resolve states, last-good retention through the rendered section, the `canRemove` scope gate, cold-cache stamping and dedupe, the pass-id guard, the `PUT` config route, and brace escaping. |
| `tests/fixtures/sample-skill.json` | Real-shape skill definition as `ctx.skills.get` returns it. |
| `README.md` / `README.zh.md` | Human docs (en default, zh). |
| `llms.txt` / `llms-full.txt` | LLM-friendly doc index / full text. |

## Key behaviors (don't break these)

1. **Packaged, not dynamic**: install via `dsh plugin add` (or profile `link:` dep + restart). Do NOT revert to a dynamic `cordis_define`-only shape.
2. **Client talks to host over HTTP only**: the client bundle polls `/skill-injector/api` and PUTs `/skill-injector/api/config` (host `webServer` routes). Do not reintroduce the dynamic `harness.handle`/`host.call` seam — it does not exist for packaged plugins.
3. **Read skill bodies from `ctx.skills`, never copy skill files**: `resolveSelection` reads the catalog once via `skills.snapshot(options)` (which reports discovery `complete`), loads bodies via `skills.get(name, options)` only for names the catalog advertises, and keeps last-good bodies in an in-process `Map` (`applyBodies` replaces a body only on `ready`). Every selected name is classified as `ready` / `unknown` / `unavailable` / `load-failed` / `no-scope` and reported in the snapshot's `unresolved` array with a reason. Do not bundle skill content into the repo or cache it across restarts.
   - **Skill lookups MUST use the live agent's scope**: `@deepseek-ai/dsh-skill-filesystem` registers in the agent preset's layer (row `skill-filesystem` in `agent.cordis.yml`), NOT the host global layer. A host-scope `ctx.skills.list({})`/`get(name, {})` returns empty. Use `{ scope: <agent>, cwd: agent.session.header.cwd }` (captured from `agent/session-start`); do not revert to scopeless lookups.
4. **`escapePromptBraces` ONLY in the section path**: the `each-prompt` section escapes `{{` in skill bodies (`renderActiveSkills` → `escapePromptBraces(renderSkillContent(...))`) because section text goes through strict `{{variable}}` interpolation; `start-only` messages are NOT interpolated and must keep raw content (`buildInjectionMessage(name, renderSkillContent(skill))`).
5. **Dedupe start-only stamps against `agent.session.events`, and stamp in two passes**: `alreadyInHistory` scans the immutable session log for `user/message` events with `data.source.kind === 'skill-invocation'` and `data.source.name`; combined with the in-process `injectedByAgent` set so resumes/restarts never double-stamp. `stampSelected` is called twice per `agent/session-start` — synchronously for a warm cache, then again after `await resolveSelection()` for a cold one (a fresh process has an empty cache, so one pass would silently stamp nothing). `agent/session-start` is emitted without `await`, so pass 2 lands a task later; keep the stamp idempotent and do not add state to it.
6. **Routes always return `{ok:false,error}` JSON**: both routes wrap handlers in try/catch and write JSON on every path (200 success, 400 invalid body/config, 500 unexpected) — never a non-JSON 500. The `PUT` config route validates via `validateSelection` before `settings.update`.
7. **`resolveSelection` is deduped (in-flight memo)**: concurrent calls share one pass via `refreshInFlight` (cleared in `.finally`) — do not remove; it prevents stampede resolves from `settings/updated`, `skills/change`, the 5s poll, and the Retry button. The memo is keyed on scope-ness + selection (`scoped:`/`unscoped:` plus the selected names), so a trigger with a *different* selection or a newly arrived scope deliberately starts a fresh pass instead of joining an older one — joining an older pass is what host test 3 pins against.
8. **`injectedByAgent` is capped at 200**: entries are evicted oldest-first (`if (injectedByAgent.size > 200) injectedByAgent.delete(first key)`) — do not remove; it bounds memory across sessions.
9. **`unknown` is the only final failure, and `canRemove` gates the UI**: only a complete, *scoped* catalog read that does not advertise a name may produce `unknown` (safe to drop). An incomplete catalog yields `unavailable`, and an unscoped read yields `no-scope` — never `unknown`. The snapshot's `canRemove` is true only after a scoped resolve has run, so a client can never delete a good selection during the boot race.

## Common tasks

- **Change poll interval**: `POLL_MS = 5000` in `src/client/index.tsx`. Keep the Client using one interval.
- **Add an injection mode**: extend the settings schema (`mode` union in `src/index.ts` + `MODES` in `src/helpers.ts`), the host branch (section vs session-start), the client radio (`si-modes`), and the tests in `tests/helpers.test.mjs`.
- **Rebuild**: `pnpm install && pnpm build` (outputs `lib/index.js` + `lib/helpers.js` + `lib/client.js`).
- **Update the live profile install**: rebuild, then restart DSH (host-half changes need restart; client changes hot-reload only for already-mounted bundles — a changed `lib/client.js` is re-hashed and re-served).

## Environment facts (probed, do not re-probe)

- **Packaged host plugins are real Node modules** (`cordis-plugin-loader` uses plain `import()`): `process.env`, `Date`, `Buffer`, and async iteration over `req` ARE available — unlike the dynamic-plugin sandbox. No cmd env-probe needed.
- `webServer.register` route shape: `{kind: 'exact'|'prefix', path, handler(req, res)}` with node:http semantics; duplicate (kind, path) throws. Register inside `ctx.effect(() => …)` and RETURN the disposer.
- The client bundle is plain browser JS (ModuleLoader CJS factory): `fetch`, `setInterval`, `document` are available; React comes from the module table (`external: react`), `React.createElement` only — no JSX.
- Host event contracts: `agent/session-start` is emitted with `{ agent, source }`; `agent.id` is the session id, `agent.inject(message)` stamps a message, `agent.session.events` is the immutable log snapshot. `settings/updated` fires with the namespace string; `skills/change` fires when the registry invalidates.
- `renderSkillContent` (canonical `<skill_content>` block) comes from `@deepseek-ai/dsh-skill`; `createUserMessage` comes from `@deepseek-ai/dsh-llm`.
- Settings namespace via `ctx.settings.register(ns, z.object({...}), { base })` (schemastery `z`); `ctx.settings.get(ns)` returns the resolved value; `ctx.settings.update(ns, patch)` merges into the user section.
- Host skill lookups need the agent scope (see Key behaviors): the plugin captures `agent` + `agent.session.header.cwd` at `agent/session-start` and passes them as lookup options. Before the first session-start the route reports `available: []`, every selected name unresolved (`no-scope`: an unscoped read can never be `unknown`), and `canRemove: false` (boot race, self-heals on the first session-start).
- `ctx.skills.snapshot(options)` returns `{ skills, complete }`; `list()` is implemented as `(await snapshot(options)).skills`. `complete: false` means discovery did not finish — retain last-good state and retry at the next boundary, never treat it as a deletion.

## Testing

- **Before restart**: verify the profile installed the bundle — `~/.dsh/profiles/web/package.json` `dependencies` and `dsh.profile.bundles` both list `skill-injector-plugin`; `lib/client.js` has the ModuleLoader wrapper (`id: "skill-injector-plugin"`); `lib/index.js` exports `name` + `apply`.
- **After restart**: `GET /skill-injector/api` (in the browser, same origin) returns `{ok:true, mode, selected, available, unresolved, missing, injected, canRemove}`; Settings → Skill Injector toggles + Save, and each unresolved row shows a reason with Retry (plus Remove once `canRemove`); `each-prompt` affects the next reply; `start-only` stamps once per session, on the first session of a fresh process too, and a resume after restart does not double-stamp; a deleted skill reports `unknown` and the rest keep injecting.
- Unit tests: `node --test --test-isolation=none "tests/**/*.mjs"` after `pnpm build` — 37 tests (`helpers.test.mjs` 30 against `lib/helpers.js`, `host.test.mjs` 7 driving `apply()` with a stub ctx). Use that in-process form under a confined shell, where `node --test tests/` (what `pnpm test` runs, canonical outside a confined shell) dies with `spawn EPERM` spawning a child per test file.

## Notes for LLM crawlers

- Listed under the GitHub topic `dsh-plugin`; packaged profile plugin for DeepSeek Harness.
- Distinguishing traits: packaged (persists across restarts), live `ctx.skills` registry (no copied skill files), two injection modes (each-prompt section vs start-only stamped message), subagents included (no filtering), HTTP-only client↔host seam (`/skill-injector/api`).
