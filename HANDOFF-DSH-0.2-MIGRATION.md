# Handoff — migrating a packaged DSH plugin to 0.2.x

You are receiving a repo that is a **packaged DeepSeek Harness (DSH) plugin** (host half + `dsh.client` browser bundle) built for **DSH 0.1.x**. Port it to **0.2.x**.

This playbook was produced by actually doing that port on `skill-injector-plugin` (1.0.0 → 1.1.0) against a live **DSH 0.2.1-rc.5**, and the per-plugin audit at the end covers **`D:\Git\dsh-mcp-toggle` 1.0.1**, whose migration is expected to be far smaller than skill-injector's.

Ground rules:

- **Do not restart the user's running DSH.** It is the process hosting the session you are in. Verify with build + typecheck + tests + static probes against the installed runtime; let the user restart.
- **Read the installed runtime, not the docs.** The authoritative sources are on disk (paths below). Everything in the delta table was verified against them.
- **Say what you verified vs. inferred.** Several 0.2 breakages are silent — a plugin whose client half never mounts throws nothing.

---

## 1. Ground truth on this machine

| Fact | Value |
| --- | --- |
| Installed DSH | `C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` — **0.2.1-rc.5** |
| Its dependency packages | `<DSH>\node_modules\@deepseek-ai\*` (all `0.2.1-rc.5`) |
| Harness home | `%USERPROFILE%\.dsh` |
| Profile | `%USERPROFILE%\.dsh\profiles\web` |
| Profile patch (composed user layer) | `…\profiles\web\cordis.patch.yml` |
| Home patch (outranks the profile layer) | `%USERPROFILE%\.dsh\cordis.patch.yml` |
| Node / pnpm | Node 24.15, pnpm 11.21 |

Shell notes for this box (both cost me time):

- `pnpm.ps1` and `npm.ps1` fail with *"StandardErrorEncoding is only supported when standard error is redirected"*. Use `cmd /c "cd /d <repo> && pnpm …"`. Appending `2>&1` breaks `cmd /c` too — don't.
- `$home` is a **read-only** PowerShell variable (case-insensitive `HOME`). Name it `$dshHome`.
- `git` refuses the repo with *"dubious ownership"* (owned by `BUILTIN\Administrators`). Use `git -c safe.directory='D:/Git/<repo>' status`; do not edit global git config.

---

## 2. The 0.1 → 0.2 contract delta

### 2.1 Removed / renamed APIs

| 0.1.x | 0.2.x | If missed |
| --- | --- | --- |
| `agent/session-start` | **`agent/created`** — `serial`, **awaited**, payload `{ agent, source, signal? }` | injection never happens |
| `settings/updated` | **`settings/document-updated(ns, revision)`**, plus `loader/volatile-update` | cache never refreshes |
| `agent.session.events` | **`agent.session.ownEvents()`** (`eventAt`/`snapshotEvents` are deprecated for new calls) | **silent** — dedupe/scan logic silently sees no history |
| `settings.register(ns, schema, {base})` + `settings.get(ns)` | export **`Config`**; Loader passes the resolved value to `apply(ctx, config)` | plugin throws on apply |
| `settings.update(ns, patch)` → user section | `settings.update(entryId, patch)` → the **profile patch's entry config** | nothing persists |
| `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"]` | **both packages were deleted in 0.2**; use `[]` unless you really depend on another client plugin's row | **silent** — client half never composes |
| peers on `dsh-client-runtime` / `dsh-client-ui-slots` | drop them; peers are `react` + `@deepseek-ai/cordis` | install warnings |

Still current, do **not** rewrite this code: `webServer.register({kind, path, handler})`, `systemPrompt.section({name, order, text})`,
`ctx.skills.snapshot/get/list({ scope, cwd })` (`scope` is a `ScopeKey` — the agent loop mints its scope keyed by the **agent object itself**, so passing the agent still works), `agent.inject(UserMessage)`, `renderSkillContent` (now needs `name`+`provider`+`resourceBase`+`content` — pass the loaded `SkillDefinition`), `createUserMessage` from `dsh-llm`, `slots.inject(key, () => slots.register({ name, id, order, label }, render))`, and the slot ids `settings.section` / `conversation.composer.dock`.

### 2.2 Settings are the plugin's Loader Config — and must be `.volatile()`

This is the one subtle change. Two *independent* failure modes hide behind "settings":

```ts
export const Config = z.object({
  mode: z.union([z.const('each-prompt'), z.const('start-only')]).default('each-prompt').volatile(),
  selected: z.array(z.string()).default([]).volatile(),
})

export function apply(ctx: Context, config?: PluginConfig): void {
  // volatile output is a REFERENCE with .get(), not a plain value:
  const mode = config?.mode?.get() ?? 'each-prompt'
}
```

Why:

1. `dsh-settings`' `SettingsForms.write()` calls `volatileForm(schema)` and throws **"no volatile fields"** when no field is volatile, then `isVolatilePath` per patch key and throws **"Config field … is not volatile"**. So `ctx.settings.update(entryId, patch)` cannot write a non-volatile field.
2. The Loader compares a config change field-by-field for volatile nodes. A volatile-only change is committed **in place** (same references get new values; `loader/volatile-update` is emitted) instead of reloading the entry — which is what keeps route registrations, caches and agent scope alive across a Save.

Consequences to respect:

- Read through `.get()` **at each use** (a helper that tolerates plain values too is nice for tests): capturing the resolved value once means a Save never takes effect.
- `entryId` is the **profile patch row id**. Resolve it from the Loader rather than hardcoding: `ctx.get('loader').entries().find(e => e.options.name === '<package-name>')?.options.id`.
- If the bundle ships its own settings page, call `ctx.settings.configure({ auto: false })` (guarded — it is newer than the Config model) so DSH does not also generate a schema page.
- Anything that still re-applies the entry (an ordinary config field, HMR, a loader reload) leaves a **fresh instance with no per-session state**: re-acquire live state lazily (e.g. `ctx.get('agents').list()`) and clear it on `agent/disposed`.

### 2.3 Version alignment

If the plugin imports `@deepseek-ai/*` at runtime, its **own duplicated copy** must sit in the same minor as the host, or the pure functions drift from the types the host accepts:

```jsonc
"dependencies": {
  "@deepseek-ai/dsh-llm":   "^0.2.1-rc.5",
  "@deepseek-ai/dsh-skill": "^0.2.1-rc.5",
  "@deepseek-ai/schemastery": "^3.18.5"
},
"peerDependencies": { "react": "^18.2.0", "@deepseek-ai/cordis": "^4.0.5" }
```

Do **not** use `~0.2.1-rc.5` — a host bump to 0.2.2 would leave the plugin on stale copies. `^` allows the whole 0.2 line.

---

## 3. Audit recipe (run in the target repo)

```powershell
# what APIs does it touch?
Get-ChildItem src -Recurse -File |
  Select-String -Pattern 'settings\.register|settings\.get|settings/updated|agent/session-start|session\.events|harness\.handle|host\.call|dsh-client-runtime|dsh-client-ui-slots|slots\.inject|ctx\.get\(|export const Config'

# what does the manifest declare?
Get-Content package.json -Raw | ConvertFrom-Json | Select-Object version,dsh,peers
```

Map each hit to an action:

| Hit | Action |
| --- | --- |
| `settings.register` / `settings.get` | §2.2 — export `Config`, make fields `.volatile()`, route writes through `settings.update` |
| `settings/updated` | `settings/document-updated` **and** `loader/volatile-update` |
| `agent/session-start` | `agent/created` (serial — bound any await, never throw) |
| `session.events` | `ownEvents()`, with `snapshotEvents()`/`events` fallbacks |
| `dsh.client.inject` with the two dead packages | `[]` (verify what the bundle actually `require`s) |
| no `@deepseek-ai/*` runtime imports | skip the version bump; nothing to align |

---

## 4. Per-plugin audit: `D:\Git\dsh-mcp-toggle` 1.0.1

**Verdict: the host half survives; the client half is the actual break.** Do not rewrite it. Verified against the installed 0.2.1-rc.5 sources:

| Claim | Evidence |
| --- | --- |
| `dsh.client.inject` names two packages that **no longer exist** | `@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-client-ui-slots` are absent from `<DSH>\node_modules\@deepseek-ai`; the client module table only resolves them as *module words* (`dsh-client-ui-renderer` does `require("@deepseek-ai/dsh-client-ui-slots")`), never as plugin rows |
| Its loader usage is unchanged | `cordis-plugin-loader/lib/types/config/entry.d.ts`: `get id()`, `get disabled()`, `update(options: Partial<EntryOptions>, create?, force?)`, `fiber?: Fiber`; `tree.d.ts`: `entries(): Generator<Entry, void, void>`, `resolve(id): Entry`; `EntryOptions` still `{id,name,config,group,disabled,inject}` |
| Its `FIBER_PHASE` mirror is still right | `cordis/lib/types/fiber.d.ts`: `PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5` |
| Its persistence target IS composed | `dsh/lib/profile-boot-*.js`: *"The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied over every profile's own layer."* Composition: bundle patches → profile `cordis.patch.yml` → home patch → `--patch` overlays. (Cross-check: this machine's `rea` MCP row exists **only** in the home patch and is live.) |
| Its client registration shape is current | `{ name: 'settings.section', id: 'mcp-toggle', order: 70, label: () => '…' }` matches the live `settings.section` contract (`id` required; `order`/`label` optional) |

So the required change list is:

1. **`package.json`** → `"dsh": { "client": { "inject": [], "platform": "web" } }` and bump `version` to `1.0.2` (or 1.1.0). The bundle only `require`s `react`, which is a module-table seed, and declares `inject = ['slots']` itself — that is the service gate.
2. **`package.json`** → optionally `@deepseek-ai/cordis` `^4.0.1` → `^4.0.5` in peers + devDependencies, and `engines.node` `>=20`. No runtime `@deepseek-ai/*` deps to align (its host half imports only `node:fs`/`node:path`/`node:os`/`node:http` types + `cordis` types).
3. **`pnpm-workspace.yaml`** → add `nodeLinker: hoisted` above `allowBuilds`. Same Windows junction trap: under the strict layout `node_modules/tsdown` is a **junction**, Node resolves `tsdown`'s nested imports from the junction path, and the build dies with `Cannot find package 'consola'`.
4. **Docs** (`AGENTS.md`, `README.md`, `README.zh.md`, `llms.txt`, `llms-full.txt`) → the only stale claims are the `dsh.client.inject` values and the "0.1.x verified" framing. Add a line to `CHANGELOG.md`.
5. **Tests** → existing tests import `../lib/index.js` and call `fiberPhaseLabel` / `isLocked`; they should pass unchanged after a rebuild. Add nothing unless you change behaviour. (Keep the CI order: `typecheck` → `build` → `node tests/*.mjs`; `pnpm test` alone runs against a stale `lib/`.)
6. **Nothing else.** No settings, no agent events, no skills, no RPC seam.

Two traps specific to this plugin:

- **It is currently disabled in the live profile.** `…\profiles\web\cordis.patch.yml` has `- id: dsh-mcp-toggle\n  disabled: true` under *"third-party plugins: disabled for the 0.1.5 -> 0.2.1 core upgrade"*. Testing it live requires flipping that to `false` **and** restarting — a disabled entry never serves its route, and the symptom looks like "the plugin still doesn't work".
- **Its own persistence writes the same file it is disabled in.** `persistDisabled()` upserts `- id: <rawId>` + `disabled:` rows into the home patch by string surgery. That is still correct in 0.2 (§4), but it means a hand-edited `disabled: true` for *this plugin's* row lives in a different file than the MCP rows it toggles. Don't conflate them.

### Definition of done for this plugin

- [ ] `pnpm install` clean, `pnpm typecheck` clean, `pnpm build` green (the `UNRESOLVED_IMPORT` warning class does not apply here — single host entry).
- [ ] `lib/index.js` still exports `name`, `inject`, `apply`, `fiberPhaseLabel`, `isLocked`.
- [ ] `lib/client.js` starts with `window.__ModuleLoader__.load({ id: "dsh-mcp-toggle", factory: …` and contains `inject = ["slots"]`.
- [ ] `package.json` `dsh.client.inject` is `[]`.
- [ ] Both tests pass after a rebuild.
- [ ] User told: reinstall + flip the profile `disabled` row to `false` + restart, then `GET /mcp-toggle/api` returns `{ok:true, entries:[…]}` and a POST toggles a server live and survives a restart.

---

## 5. Procedure (general)

1. `pnpm install` (expect the lockfile to need `--no-frozen-lockfile` after any manifest edit; with `CI=true` to avoid the "no TTY" abort on the modules purge).
2. Apply the manifest changes (§2.3, `dsh.client.inject`).
3. Apply the code changes the audit table calls for.
4. `pnpm typecheck` — this is the real oracle: it now typechecks against **0.2.1 types**, so a wrong signature fails here rather than at runtime.
5. `pnpm build`, then the tests.
6. Run the static probes in §6 that apply to the plugin's features.
7. Update docs; state the reinstall/restart steps for the user.

---

## 6. Static probes (no DSH restart needed)

These are the cheap checks that catch what unit tests with stubs cannot. Run them from the repo root as a throwaway `.mjs`, then delete it.

**A. Manifest + bundle shape** (all plugins):

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
assert.deepEqual(pkg.dsh.client.inject, [])                       // no dead package rows
assert.equal(pkg.dsh.client.platform, 'web')
const client = readFileSync('lib/client.js', 'utf8')
assert.ok(client.includes(`__ModuleLoader__.load({ id: "${pkg.name}"`))
assert.ok(/inject\s*=\s*\["slots"\]/.test(client))
const host = await import('./lib/index.js')
assert.equal(typeof host.apply, 'function')
assert.equal(host.name, pkg.name)
```

**B. If the plugin declares a Config** — prove the real `dsh-settings` write gate accepts it (copy of `volatileForm`/`isVolatilePath` from `dsh-settings/lib/index.js`):

```js
import z from '@deepseek-ai/schemastery'
import { Config } from './lib/index.js'
const plain = (s) => { const r = new z(s.toJSON()); const walk = (n) => { delete n.meta.volatile; for (const c of Object.values(n.dict ?? {})) walk(c); if (n.inner) walk(n.inner); for (const c of n.list ?? []) walk(c) }; walk(r); return r }
const volatileForm = (s) => s.meta.volatile ? plain(s) : s.type === 'object'
  ? (() => { const d = Object.fromEntries(Object.entries(s.dict ?? {}).flatMap(([k, c]) => { const f = volatileForm(c); return f === undefined ? [] : [[k, f]] })); return Object.keys(d).length ? z.object(d) : undefined })()
  : undefined
const isVolatilePath = (s, p) => { if (s.meta.volatile) return true; const [k, ...r] = p; const c = k === undefined ? undefined : s.dict?.[k]; return c !== undefined && isVolatilePath(c, r) }
const form = volatileForm(Config)
if (form === undefined) throw new Error('dsh-settings would reject this Config: no volatile fields')
for (const key of Object.keys(form.dict ?? {})) if (!isVolatilePath(Config, [key])) throw new Error(`not volatile: ${key}`)
// and cordis validates Config through the Standard-Schema probe:
const std = Config['~standard']
if (typeof std?.validate !== 'function') throw new Error('Config is not a Standard Schema')
```

**C. If the plugin builds messages / renders skill markup** — the plugin's *own* duplicated `dsh-llm`/`dsh-skill` copy must satisfy the **host's** validators:

```js
import { pathToFileURL } from 'node:url'
const HOST = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const session = await import(pathToFileURL(`${HOST}/dsh-session/lib/types/surface.js`).href)
const llm = await import(pathToFileURL(`${HOST}/dsh-llm/lib/index.js`).href)
// build your message the way the plugin does, then:
session.validateSessionEventData({ type: 'user/message', data: message })   // must not throw
```

**D. If the plugin drives the Loader** (mcp-toggle does) — probe the live service shape against the *installed* cordis types instead of trusting the old comment: open `cordis-plugin-loader/lib/types/config/{entry,tree}.d.ts` and `cordis/lib/types/fiber.d.ts`, and confirm every member the plugin reads still exists with the same signature. That is what §4 did.

---

## 7. Gotchas, each of which cost a round trip

1. **Volatile is load-bearing twice.** Dropping `.volatile()` breaks *Save* (rejected write) and *liveness* (entry reload on every save). Adding it changes the config's runtime shape to `.get()` references — read through them.
2. **`dsh.client.inject` with a dead package does not error.** `ClientEntries.arriveGraphRow` silently skips an inject name that is not a graph row, so the bundle still materialises — but cordis may still compose the entry with edges for a package that never arrives. `[]` is the only safe declaration unless you need another client plugin's row.
3. **Windows pnpm junctions break nested resolution.** Symptom: `Cannot find package 'consola' imported from …tsdown/dist/…`. Fix: `nodeLinker: hoisted` in `pnpm-workspace.yaml`.
4. **A fresh pnpm install can abort with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.** Set `CI=true`; and `--no-frozen-lockfile` after editing the manifest.
5. **`UNRESOLVED_IMPORT` for `./helpers.js` is benign** when helpers is a separate tsdown entry: `lib/index.js` imports `./helpers.js`, which resolves next to it at runtime. Prove it with the tests, don't "fix" it.
6. **A config change may re-apply the entry.** Anything kept in closure state (body caches, agent scope, per-session ledgers) must be recoverable lazily, or the UI goes blank until the next session.
7. **Serial events must not throw.** `agent.created` listeners run before creation resolves; a throw fails agent creation. Wrap the body, and bound any await with a deadline.
8. **Don't trust a plugin's own stale comments about the runtime.** mcp-toggle's header says persistence goes to `$DSH_HOME/cordis.patch.yml`; that turned out to still be true in 0.2 — but only because I checked `profile-boot`, not because the comment said so.
9. **A disabled profile row beats every code fix.** Check the profile patch for `- id: <plugin>` + `disabled: true` before debugging anything live.
10. **`lib/` is committed in these repos.** Rebuild it in the same change, or a `git`/`link:` install ships the old bundle.

---

## 8. Reference: what the skill-injector migration actually changed

Use it as a shape reference for a plugin that *does* need the full treatment.

| File | Change |
| --- | --- |
| `src/index.ts` | `export const Config` (both fields `.volatile()`); `config()` reads through `.get()`; `settings.update(entryId, patch)` for the PUT route; `agent/created` replaces session-start (awaits the cold-cache resolve with a 3s deadline, returns a promise so input is held); `historyEvents()` prefers `ownEvents()`; lazy agent recovery from `ctx.get('agents').list()` + `agent/disposed` cleanup; `settings.configure({auto:false})`; `registerRoute()` contains duplicate-registration failures |
| `package.json` | deps `^0.2.1-rc.5` (`dsh-llm`, `dsh-skill`), schemastery `^3.18.5`; peers `react` + `cordis ^4.0.5`; dead peers dropped; `dsh.client.inject: []`; version 1.1.0 |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted` |
| `tests/host.test.mjs` | stub ctx now takes volatile refs and re-implements `settings.update` as *commit + emit `loader/volatile-update`*, plus a test that a Save takes effect **without a reload** |
| docs | contract table 0.1 → 0.2 (this file's §2 is the distilled version) |

Final state: `pnpm typecheck` clean, `pnpm build` green, 39/39 tests, and the two cross-package probes (§6 B/C) passing against the installed 0.2.1-rc.5.
