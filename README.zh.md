# skill-injector-plugin · 自动向 DeepSeek Harness (DSH) 注入技能

> Auto-inject user-chosen skills (e.g. `/caveman`, `/ponytail`) into every DSH session — every prompt or once at session start — with a settings page and a composer indicator. 在 DSH 会话中自动注入所选技能（如 /caveman、/ponytail）：每轮提示或仅在会话开始时，含设置页与输入区指示。
>
> English: [README.md](README.md) · LLM index: [llms.txt](llms.txt) · Agent guide: [AGENTS.md](AGENTS.md)

![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-4c8dff) ![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-✓-0f1115) ![license](https://img.shields.io/badge/license-MIT-green) ![install](https://img.shields.io/badge/dsh%20plugin%20add-✓-22c55e)

**关键词**：`dsh-plugin` · `deepseek-harness-plugin` · skills · skill-injection · caveman · ponytail

---

## 📑 目录

- [✨ 功能](#-功能)
- [🏗️ 工作原理](#️-工作原理)
- [🚀 快速开始](#-快速开始)
- [⚙️ 配置](#️-配置)
- [❓ 常见问题](#-常见问题)
- [⚠️ 安全说明](#️-安全说明)
- [📦 项目结构](#-项目结构)
- [🙏 致谢](#-致谢)

---

## ✨ 功能

| 功能 | 说明 |
| --- | --- |
| ⚙️ **设置页** | 设置 → Skill Injector：可用技能复选框列表、注入模式单选、保存；显示缺失技能与会话内激活状态 |
| 🪧 **输入区指示** | 聊天输入框下方一行：`Skills: caveman, ponytail · every prompt`，每 5 秒刷新 |
| 🔁 **两种注入模式** | `each-prompt`（系统提示词分区，每次请求重新渲染）vs `start-only`（会话开始时盖戳一条持久的技能调用消息） |
| 📚 **实时技能注册表** | 加载时从 `ctx.skills` 读取技能正文；不复制任何文件；技能被删除时优雅降级（列为缺失） |
| 🧩 **包含子代理** | 注入同样作用于子代理（语气一致；不过滤） |
| 🌗 **主题自适应** | 所有颜色使用 `--dsw-alias-*` 设计令牌 |
| ♨️ **重启不丢失** | 真正的 profile 打包插件：用 `dsh plugin add` 安装一次，每次 DSH 启动自动加载——无需会话级 define，无需 cordis_define |

## 🏗️ 工作原理

```
设置页（浏览器）
  └─ 用户选择技能 + 注入模式
             │ PUT /skill-injector/api/config
Host 半部（DSH 进程） ▼
  └─ skill-injector 设置命名空间（mode + selected）
  └─ ctx.skills.get(name) → 从技能注册表读取实时技能正文
  └─ each-prompt：systemPrompt.section（每次请求重新渲染）
     或 start-only：agent/session-start 时 agent.inject()（每技能盖戳一条）
  └─ webServer 路由 GET /skill-injector/api → JSON 快照
             │
Client bundle（浏览器） ▼
  └─ 单一 5 秒轮询器 → fetch(/skill-injector/api)
       ├─ settings.section（id skill-injector）              → 复选框列表 + 模式单选 + 保存
       └─ conversation.composer.dock（id skill-injector-dock）→ 激活技能行
```

- **纯拉取模型**：无推送、无事件驱动 UI——客户端每 5 秒轮询 `/skill-injector/api`，Host 按需重读 `ctx.skills`；技能文件缺失时在快照中体现为 `missing`，界面列出该技能，轮询自动恢复。
- **实时注册表**：注入始终在加载时从 `ctx.skills` 读取技能正文——本包不复制任何内容，因此技能修改会被拾取，被删除的技能优雅降级。
- **持久化**：随附 `dsh.bundle`（`cordis.patch.yml`）+ `dsh.client`（`exports["./client"]`，已打包），作为真正的 profile 插件安装，DSH 每次启动都会加载。

## 🚀 快速开始

### 标准安装：`dsh plugin add`（重启不丢失）

从本地仓库安装（或发布后从 GitHub 安装）：

```bash
# 本地目录（在本仓库的上级目录执行）：
dsh plugin --profile web add ./skill-injector-plugin

# 或直接从 GitHub（任意 DSH 机器）：
dsh plugin --profile web add git+https://github.com/<org>/skill-injector-plugin.git
```

`dsh plugin add` 即向 profile 执行 pnpm add，并同步 `dsh.profile.bundles`：检测到本包的 `dsh.bundle` 声明后，会把 `skill-injector-plugin` 追加进 bundle 栈。**重启 DSH**（或硬刷新）。启动时 client-modules 扫描器解析 `exports["./client"]`，设置页与输入区指示随即出现。无需会话级 define，重启不丢失。

### 手动挂载到 profile（备选）

1. `git clone <repo-url>`（任意位置）。
2. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中加入 `"skill-injector-plugin": "link:<仓库路径>"`，然后在 profile 目录执行 `pnpm install`。
3. 重启 DSH。

### 依赖

- 技能需存在于 `~/.agents/skills`（或 `ctx.skills` 注册表读取的其他已配置技能根目录）。
- 未选择任何技能 → 不注入任何内容；输入区指示显示 `Skills: none`，设置页仍正常工作。

## ⚙️ 配置

无配置文件。设置位于 `skill-injector` 设置命名空间，通过 设置 → Skill Injector 编辑，并持久化到用户设置文档：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `'each-prompt'` | 注入模式：`'each-prompt'`（系统提示词分区，每次请求）或 `'start-only'`（会话开始时盖戳一条消息） |
| `selected` | `[]` | 要注入的 kebab-case 技能名（最多 16 个，经校验；重复项去重） |

命名空间通过 `ctx.settings.register('skill-injector', schema, { base })` 注册——存储的用户分区自动叠加在 base 之上，因此空值/无效的存储值会回退到 `{ mode: 'each-prompt', selected: [] }`。

## ❓ 常见问题

**问：为什么我的设置不作用于已经打开的会话？**
答：`each-prompt` 模式下分区按请求重新渲染，下一次请求即生效。`start-only` 模式在会话开始时一次性盖戳——只作用于更改之后新建的会话，不影响已打开的会话。

**问：技能文件被删除会怎样？**
答：该技能停止注入，并在设置页的“缺失技能”中列出；其余已选技能继续工作。恢复文件后，下一次刷新会重新拾取。

**问：子代理会遵循注入的技能吗？**
答：会——注入默认同样作用于子代理，不做来源过滤。所选语气在整个代理树中保持一致。

**问：token 成本是多少？**
答：无论哪种模式，技能内容每次请求都会发送：`each-prompt` 常驻系统提示词，`start-only` 存在于一条盖戳消息中；两者每轮对模型均可见。只选择你真正需要生效的技能。

**问：如何卸载？**
答：`dsh plugin --profile web rm skill-injector-plugin`（或删除 profile 依赖与 bundle 条目）并重启 DSH。

## ⚠️ 安全说明

- 插件对技能注册表**只读**——绝不写入、重命名或删除技能文件。
- 选择保存在**用户设置文档**中（与 DSH 其他设置同一存储）。
- 注入内容是技能**自身可信的本地 markdown**；不从网络获取任何内容。
- 在 `each-prompt`（系统提示词分区）路径中，技能正文里的 `{{` 会被转义，以免严格变量插值失败；`start-only` 消息不参与插值，保留原始内容。

## 📦 项目结构

```
skill-injector-plugin/
├── src/
│   ├── index.ts            # Host 半部：设置命名空间、技能缓存、分区 + 会话启动注入、路由
│   ├── helpers.ts          # 纯函数：validateSelection、escapePromptBraces、buildInjectionMessage
│   └── client/index.tsx    # Client bundle：5 秒轮询、设置表单、输入区指示行
├── cordis.patch.yml        # dsh.bundle 补丁（启动时插入插件行）
├── tsdown.config.ts        # 构建 Host（node ESM）+ helpers + Client（CJS ModuleLoader）
├── package.json            # name、exports["./client"]、dsh.client + dsh.bundle
├── lib/                    # 构建产物（index.js、helpers.js、client.js）
├── tests/
│   ├── helpers.test.mjs    # 针对 lib/helpers.js 的 node:test 单元测试
│   └── fixtures/           # 真实形态的技能定义样例
├── AGENTS.md               # 面向 AI agent 的仓库指引
├── llms.txt / llms-full.txt
├── README.md / README.zh.md
└── LICENSE
```

## 🙏 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— DSH 插件/动态运行时、Slots、主题、webServer、client-modules。
- [headroom-stats-plugin](https://github.com/headroomlabs-ai/headroom/) —— 打包式插件模式参考（manifest、构建、README 结构）。
- [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) —— 打包式 client-plugin 构建模式参考。

## 📄 许可证

[MIT](LICENSE)
