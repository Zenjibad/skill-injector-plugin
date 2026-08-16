# skill-injector-plugin · Auto-Inject Skills into DeepSeek Harness (DSH)

> Auto-inject user-chosen skills (e.g. `/caveman`, `/ponytail`) into every DSH session — every prompt or once at session start — with a settings page and a composer indicator. 在 DSH 会话中自动注入所选技能（如 /caveman、/ponytail）：每轮提示或仅在会话开始时，含设置页与输入区指示。
>
> 中文文档: [README.zh.md](README.zh.md) · LLM index: [llms.txt](llms.txt) · Agent guide: [AGENTS.md](AGENTS.md)

![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-4c8dff) ![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-✓-0f1115) ![license](https://img.shields.io/badge/license-MIT-green) ![install](https://img.shields.io/badge/dsh%20plugin%20add-✓-22c55e)

**Keywords**: `dsh-plugin` · `deepseek-harness-plugin` · skills · skill-injection · caveman · ponytail

---

## 📑 Table of Contents

- [✨ Features](#-features)
- [🏗️ How it works](#️-how-it-works)
- [🚀 Quick start](#-quick-start)
- [⚙️ Configuration](#️-configuration)
- [❓ FAQ](#-faq)
- [⚠️ Security notes](#️-security-notes)
- [📦 Project structure](#-project-structure)
- [🙏 Credits](#-credits)

---

## ✨ Features

| Feature | Description |
| --- | --- |
| ⚙️ **Settings page** | Settings → Skill Injector: checkbox list of available skills, injection-mode radio, save; shows missing skills + active-in-session status |
| 🪧 **Composer indicator** | One line under the chat input: `Skills: caveman, ponytail · every prompt`, refreshed every 5s |
| 🔁 **Two injection modes** | `each-prompt` (system-prompt section, re-rendered every request) vs `start-only` (one durable skill-invocation message stamped at session start) |
| 📚 **Live skill registry** | Reads skill bodies from `ctx.skills` at load time; no copied files; deleted skills degrade gracefully (listed as missing) |
| 🧩 **Subagents included** | Injection applies to subagents too (consistent voice; no filtering) |
| 🌗 **Theme-aware** | All colors use `--dsw-alias-*` design tokens |
| ♨️ **Survives restarts** | Real profile-bundled plugin: install once with `dsh plugin add`, auto-loads on every DSH boot — no per-session define, no cordis_define |

## 🏗️ How it works

```
Settings page (browser)
  └─ user picks skills + injection mode
             │ PUT /skill-injector/api/config
Host half (DSH process) ▼
  └─ skill-injector settings namespace (mode + selected)
  └─ ctx.skills.get(name) → live skill bodies from the skill registry
  └─ each-prompt: systemPrompt.section (re-rendered every request)
     OR start-only: agent.inject() on agent/session-start (one stamp per skill)
  └─ webServer route GET /skill-injector/api → JSON snapshot
             │
Client bundle (browser) ▼
  └─ single 5s poller → fetch(/skill-injector/api)
       ├─ settings.section (id skill-injector)              → checkbox list + mode radio + save
       └─ conversation.composer.dock (id skill-injector-dock) → active-skills line
```

- **Pure pull model**: no push, no events driving the UI — the client polls `/skill-injector/api` every 5s and the host re-reads `ctx.skills` on demand; a missing skill file shows up as `missing` in the snapshot and the UI lists it, polling self-recovers.
- **Live registry**: injection always reads the skill bodies from `ctx.skills` at load time — nothing is copied into this package, so skill edits are picked up and deleted skills degrade gracefully.
- **Persistence**: ships `dsh.bundle` (`cordis.patch.yml`) + `dsh.client` (`exports["./client"]`, bundled) so it installs as a real profile plugin that DSH loads on every boot.

## 🚀 Quick start

### Standard install: `dsh plugin add` (persists across restarts)

Install the package from a local checkout (or from GitHub once published):

```bash
# local directory (from the parent of this repo):
dsh plugin --profile web add ./skill-injector-plugin

# or directly from GitHub (any DSH machine):
dsh plugin --profile web add git+https://github.com/<org>/skill-injector-plugin.git
```

`dsh plugin add` is a pnpm add into the profile plus a `dsh.profile.bundles` reconcile: seeing this package's `dsh.bundle` declaration, it appends `skill-injector-plugin` to the bundle stack. **Restart DSH** (or hard-refresh). On boot the client-modules scanner resolves `exports["./client"]` and the settings page + dock line appear. No per-session define, survives restarts.

### Manual profile mount (alternative)

1. `git clone <repo-url>` (any location).
2. Add to `~/.dsh/profiles/web/package.json` `dependencies`: `"skill-injector-plugin": "link:<repo-path>"`, then `pnpm install` in the profile dir.
3. Restart DSH.

### Requirements

- Skills exist in `~/.agents/skills` (or another configured skill root the `ctx.skills` registry reads).
- No skill selected → nothing is injected; the dock line shows `Skills: none` and the settings page still works.

## ⚙️ Configuration

No config file. Settings live in the `skill-injector` settings namespace, edited from Settings → Skill Injector and persisted in the user settings document:

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `'each-prompt'` | Injection mode: `'each-prompt'` (system-prompt section, every request) or `'start-only'` (one stamped message at session start) |
| `selected` | `[]` | Kebab-case skill names to inject (max 16, validated; duplicates deduped) |

The namespace is registered via `ctx.settings.register('skill-injector', schema, { base })` — the stored user section layers over the base automatically, so an empty/invalid stored value falls back to `{ mode: 'each-prompt', selected: [] }`.

## ❓ FAQ

**Q: Why don't my settings apply to the session I already have open?**
A: In `each-prompt` mode the section is re-rendered per request, so the next request picks it up. In `start-only` mode the stamp is written once at session start — it applies to sessions started after the change, not the one already open.

**Q: What happens when a skill file is deleted?**
A: The skill is dropped from injection and listed under "Missing skills" on the settings page; every other selected skill keeps working. Restore the file and the next refresh picks it up again.

**Q: Do subagents follow the injected skills?**
A: Yes — injection applies to subagents too, by design, with no origin filtering. The chosen voice is consistent across the whole agent tree.

**Q: What is the token cost?**
A: The skill content is sent every request either way: `each-prompt` keeps it in the system prompt, `start-only` in one stamped message; both are visible to the model on every turn. Select only the skills you actually want active.

**Q: How do I remove it?**
A: `dsh plugin --profile web rm skill-injector-plugin` (or delete the profile dependency + bundle entry) and restart DSH.

## ⚠️ Security notes

- The plugin is **read-only** over the skill registry — it never writes, renames, or deletes skill files.
- The selection is stored in the **user settings document** (same store as other DSH settings).
- Injected content is the skill's **own trusted local markdown**; nothing is fetched from the network.
- In the `each-prompt` (system-prompt section) path, `{{` in skill bodies is escaped to keep strict variable interpolation from failing; `start-only` messages are not interpolated, so they keep the raw content.

## 📦 Project structure

```
skill-injector-plugin/
├── src/
│   ├── index.ts            # host half: settings namespace, skill cache, section + session-start injection, routes
│   ├── helpers.ts          # pure helpers: validateSelection, escapePromptBraces, buildInjectionMessage
│   └── client/index.tsx    # client bundle: 5s poller, settings form, dock line
├── cordis.patch.yml        # dsh.bundle patch (inserts the plugin row on boot)
├── tsdown.config.ts        # builds host (node ESM) + helpers + client (CJS ModuleLoader)
├── package.json            # name, exports["./client"], dsh.client + dsh.bundle
├── lib/                    # build output (index.js, helpers.js, client.js)
├── tests/
│   ├── helpers.test.mjs    # node:test unit tests against lib/helpers.js
│   └── fixtures/           # real-shape skill definition sample
├── AGENTS.md               # repository guide for AI agents
├── llms.txt / llms-full.txt
├── README.md / README.zh.md
└── LICENSE
```

## 🙏 Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the DSH plugin/dynamic runtime, Slots, theme, webServer, client-modules.
- [headroom-stats-plugin](https://github.com/Zenjibad/headroom-stats-plugin) — packaged-plugin pattern reference (manifest, build, README structure).
- [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — reference for the packaged client-plugin build pattern.

## 📄 License

[MIT](LICENSE)
