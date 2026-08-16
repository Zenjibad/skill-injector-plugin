# AGENTS.md — Guide for AI agents

This file helps AI coding agents and LLM tooling understand and work with this repository quickly.

## What this repo is

`skill-injector-plugin` is a **packaged Cordis plugin for DeepSeek Harness (DSH)** that auto-injects user-chosen skills (e.g. `caveman`, `ponytail`) into sessions — either every prompt (`each-prompt` via a `systemPrompt.section`) or once at session start (`start-only` via `agent.inject()` on `agent/session-start`) — with a settings page and a composer dock line. It is a real profile-bundled plugin: `dsh.bundle` (`cordis.patch.yml`) mounts the host half, and the `dsh.client` declaration + `exports["./client"]` register the browser half — install once with `dsh plugin add`, loads on every DSH boot, no cordis_define. The host half owns a `skill-injector` settings namespace (`mode` + `selected`), reads skill bodies from the live `ctx.skills` registry, and serves the snapshot over `GET /skill-injector/api` (plus `PUT /skill-injector/api/config` for writes); the client half polls every 5s and renders a `settings.section` form and a `conversation.composer.dock` line. The client↔host seam is **HTTP only** — there is no `harness.handle`/`host.call` RPC for packaged plugins.

## Repository layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Host half: `skill-injector` settings namespace (schemastery schema + base), `refreshCache` skill-body cache, `systemPrompt.section` (each-prompt, order 150) + `agent/session-start` injection (start-only, deduped), `webServer` routes `GET /skill-injector/api` + `PUT /skill-injector/api/config`. |
| `src/helpers.ts` | Pure helpers (separate build entry for unit testing): `validateSelection`, `escapePromptBraces`, `buildInjectionMessage`, `isSkillName`, `MAX_SELECTED`, types. |
| `src/client/index.tsx` | Client bundle: single 5s poller `fetch('/skill-injector/api')`, `settings.section` id `skill-injector` (order 60), `conversation.composer.dock` id `skill-injector-dock` (order 10). |
| `cordis.patch.yml` | `dsh.bundle.patch`: inserts the plugin row `{id: skill-injector-plugin, name: 'skill-injector-plugin'}`. |
| `tsdown.config.ts` | Builds host (node ESM → `lib/index.js`), helpers (node ESM → `lib/helpers.js`), client (browser CJS ModuleLoader closure → `lib/client.js`, bundle id = package name). |
| `package.json` | `exports["./client"]`, `dsh.bundle.patch`, `dsh.client` (`platform: 'web'`, inject edges), peers react + @deepseek-ai/cordis + client runtime/slots, deps @deepseek-ai/dsh-llm + dsh-skill + schemastery. |
| `tests/helpers.test.mjs` | node:test unit tests against `lib/helpers.js` (14 tests). |
| `tests/fixtures/sample-skill.json` | Real-shape skill definition as `ctx.skills.get` returns it. |
| `README.md` / `README.zh.md` | Human docs (en default, zh). |
| `llms.txt` / `llms-full.txt` | LLM-friendly doc index / full text. |

## Key behaviors (don't break these)

1. **Packaged, not dynamic**: install via `dsh plugin add` (or profile `link:` dep + restart). Do NOT revert to a dynamic `cordis_define`-only shape.
2. **Client talks to host over HTTP only**: the client bundle polls `/skill-injector/api` and PUTs `/skill-injector/api/config` (host `webServer` routes). Do not reintroduce the dynamic `harness.handle`/`host.call` seam — it does not exist for packaged plugins.
3. **Read skill bodies from `ctx.skills`, never copy skill files**: `refreshCache` loads each selected skill via `skills.get(name, {})` and keeps bodies in an in-process `Map`; deleted skills are reported in `missing` and skipped — do not bundle skill content into the repo or cache it across restarts.
   - **Skill lookups MUST use the live agent's scope**: `@deepseek-ai/dsh-skill-filesystem` registers in the agent preset's layer (row `skill-filesystem` in `agent.cordis.yml`), NOT the host global layer. A host-scope `ctx.skills.list({})`/`get(name, {})` returns empty. Use `{ scope: <agent>, cwd: agent.session.header.cwd }` (captured from `agent/session-start`); do not revert to scopeless lookups.
4. **`escapePromptBraces` ONLY in the section path**: the `each-prompt` section escapes `{{` in skill bodies (`renderActiveSkills` → `escapePromptBraces(renderSkillContent(...))`) because section text goes through strict `{{variable}}` interpolation; `start-only` messages are NOT interpolated and must keep raw content (`buildInjectionMessage(name, renderSkillContent(skill))`).
5. **Dedupe start-only stamps against `agent.session.events`**: `alreadyInHistory` scans the immutable session log for `user/message` events with `data.source.kind === 'skill-invocation'` and `data.source.name`; combined with the in-process `injectedByAgent` set so resumes/restarts never double-stamp.
6. **Routes always return `{ok:false,error}` JSON**: both routes wrap handlers in try/catch and write JSON on every path (200 success, 400 invalid body/config, 500 unexpected) — never a non-JSON 500. The `PUT` config route validates via `validateSelection` before `settings.update`.
7. **`refreshCache` is deduped (in-flight memo)**: concurrent calls share one pass via `refreshInFlight` (cleared in `.finally`) — do not remove; it prevents stampede refreshes on `settings/updated` + `skills/change`.
8. **`injectedByAgent` is capped at 200**: entries are evicted oldest-first (`if (injectedByAgent.size > 200) injectedByAgent.delete(first key)`) — do not remove; it bounds memory across sessions.

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
- Host skill lookups need the agent scope (see Key behaviors): the plugin captures `agent` + `agent.session.header.cwd` at `agent/session-start` and passes them as lookup options. Before the first session-start the route reports `available: []` and nothing is cached (boot race, self-heals on the first session-start).

## Testing

- **Before restart**: verify the profile installed the bundle — `~/.dsh/profiles/web/package.json` `dependencies` and `dsh.profile.bundles` both list `skill-injector-plugin`; `lib/client.js` has the ModuleLoader wrapper (`id: "skill-injector-plugin"`); `lib/index.js` exports `name` + `apply`.
- **After restart**: `GET /skill-injector/api` (in the browser, same origin) returns `{ok:true, mode, selected, available, missing, injected}`; Settings → Skill Injector toggles + Save; `each-prompt` affects the next reply; `start-only` stamps once per session and a resume after restart does not double-stamp; a deleted skill shows under missing and the rest keep injecting.
- Unit tests: `node tests/helpers.test.mjs` (14 tests) against `lib/helpers.js` — run after `pnpm build` so `lib/` is fresh.

## Notes for LLM crawlers

- Listed under the GitHub topic `dsh-plugin`; packaged profile plugin for DeepSeek Harness.
- Distinguishing traits: packaged (persists across restarts), live `ctx.skills` registry (no copied skill files), two injection modes (each-prompt section vs start-only stamped message), subagents included (no filtering), HTTP-only client↔host seam (`/skill-injector/api`).
