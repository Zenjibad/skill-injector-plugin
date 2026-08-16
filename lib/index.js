import z from "@deepseek-ai/schemastery";
import { isModelInvocable, renderSkillContent } from "@deepseek-ai/dsh-skill";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { buildInjectionMessage, escapePromptBraces, validateSelection } from "./helpers.js";

//#region src/index.ts
const name = "skill-injector-plugin";
const inject = [
	"webServer",
	"settings",
	"skills",
	"systemPrompt"
];
const NAMESPACE = "skill-injector";
const SECTION_NAME = "skill-injector:active";
const SECTION_ORDER = 150;
function apply(ctx) {
	const c = ctx;
	const { webServer, settings, skills, systemPrompt } = c;
	const schema = z.object({
		mode: z.union([z.const("each-prompt"), z.const("start-only")]).default("each-prompt"),
		selected: z.array(z.string()).default([])
	});
	settings.register(NAMESPACE, schema, { base: {
		mode: "each-prompt",
		selected: []
	} });
	/** Resolved, validated config; falls back to the base on any invalidity. */
	function config() {
		const raw = settings.get(NAMESPACE);
		const r = validateSelection(raw ?? {});
		return r.ok ? r.config : {
			mode: "each-prompt",
			selected: []
		};
	}
	/** name -> loaded skill body for the current selection. */
	const cache = new Map();
	/** agentId -> skill names stamped in start-only mode. */
	const injectedByAgent = new Map();
	let currentAgentId = null;
	/** In-flight refresh promise so concurrent refreshCache calls share one pass. */
	let refreshInFlight = null;
	function refreshCache() {
		if (refreshInFlight !== null) return refreshInFlight;
		refreshInFlight = (async () => {
			const missing = [];
			const selected = config().selected;
			const next = new Map();
			for (const name$1 of selected) try {
				const skill = await skills.get(name$1, {});
				if (skill === undefined || typeof skill.content !== "string") {
					missing.push(name$1);
					continue;
				}
				next.set(name$1, {
					name: skill.name,
					description: skill.description,
					content: skill.content,
					provider: skill.provider,
					...skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}
				});
			} catch {
				missing.push(name$1);
			}
			cache.clear();
			for (const [key, value] of next) cache.set(key, value);
			return missing;
		})().finally(() => {
			refreshInFlight = null;
		});
		return refreshInFlight;
	}
	/** Concatenated <skill_content> blocks for the selection (each-prompt path). */
	function renderActiveSkills() {
		const blocks = [];
		for (const name$1 of config().selected) {
			const skill = cache.get(name$1);
			if (skill === undefined) continue;
			blocks.push(escapePromptBraces(renderSkillContent(skill)));
		}
		return blocks.join("\n\n");
	}
	/** True when the session log already carries a stamped skill-invocation for `name`. */
	function alreadyInHistory(agent, name$1) {
		try {
			const events = agent.session?.events;
			if (!Array.isArray(events)) return false;
			return events.some((e) => e.type === "user/message" && e.data?.source?.kind === "skill-invocation" && e.data.source.name === name$1);
		} catch {
			return false;
		}
	}
	ctx.effect(() => systemPrompt.section({
		name: SECTION_NAME,
		order: SECTION_ORDER,
		text: () => config().mode === "each-prompt" ? renderActiveSkills() : ""
	}));
	ctx.effect(() => c.on("agent/session-start", ({ agent }) => {
		if (agent?.id === undefined || agent.inject === undefined) return;
		currentAgentId = agent.id;
		if (config().mode !== "start-only") return;
		const stamped = new Set(injectedByAgent.get(agent.id) ?? []);
		for (const name$1 of config().selected) {
			const skill = cache.get(name$1);
			if (skill === undefined || stamped.has(name$1)) continue;
			if (alreadyInHistory(agent, name$1)) {
				stamped.add(name$1);
				continue;
			}
			try {
				agent.inject(createUserMessage(buildInjectionMessage(name$1, renderSkillContent(skill))));
				stamped.add(name$1);
			} catch {}
		}
		injectedByAgent.set(agent.id, [...stamped]);
		if (injectedByAgent.size > 200) injectedByAgent.delete(injectedByAgent.keys().next().value);
	}));
	async function buildSnapshot(missing) {
		const cfg = config();
		let available = [];
		try {
			available = (await skills.list({})).filter(isModelInvocable).map((s) => ({
				name: s.name,
				description: s.description
			}));
		} catch {
			available = [];
		}
		return {
			ok: true,
			mode: cfg.mode,
			selected: cfg.selected,
			available,
			missing,
			injected: currentAgentId !== null ? injectedByAgent.get(currentAgentId) ?? [] : []
		};
	}
	ctx.effect(() => {
		const disposers = [];
		disposers.push(c.on("settings/updated", (ns) => {
			if (ns === NAMESPACE) void refreshCache();
		}));
		disposers.push(c.on("skills/change", () => void refreshCache()));
		disposers.push(webServer.register({
			kind: "exact",
			path: "/skill-injector/api",
			handler: async (_req, res) => {
				try {
					const missing = await refreshCache();
					const body = JSON.stringify(await buildSnapshot(missing));
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(body);
				} catch (e) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						ok: false,
						error: String(e?.message ?? e)
					}));
				}
			}
		}));
		disposers.push(webServer.register({
			kind: "exact",
			path: "/skill-injector/api/config",
			handler: async (req, res) => {
				try {
					const chunks = [];
					for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
					const bodyText = Buffer.concat(chunks).toString("utf8");
					let parsed;
					try {
						parsed = JSON.parse(bodyText);
					} catch {
						res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							ok: false,
							error: "request body must be JSON"
						}));
						return;
					}
					const r = validateSelection(parsed);
					if (!r.ok) {
						res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							ok: false,
							error: r.error
						}));
						return;
					}
					await settings.update(NAMESPACE, r.config);
					const missing = await refreshCache();
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(JSON.stringify(await buildSnapshot(missing)));
				} catch (e) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						ok: false,
						error: String(e?.message ?? e)
					}));
				}
			}
		}));
		void refreshCache();
		return () => {
			for (const d of disposers) try {
				d();
			} catch {}
		};
	});
}

//#endregion
export { apply, inject, name };