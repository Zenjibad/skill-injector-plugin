import z from "@deepseek-ai/schemastery";
import { isModelInvocable, renderSkillContent } from "@deepseek-ai/dsh-skill";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { applyBodies, buildInjectionMessage, classifySelection, escapePromptBraces, validateSelection } from "./helpers.js";

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
	/** Skill lookups MUST use the live agent's scope: the filesystem provider
	* registers in the agent preset's layer, so a host-global lookup is empty. */
	function lookupOptions() {
		if (currentAgent === null) return undefined;
		return currentAgent.cwd !== undefined ? {
			scope: currentAgent.scope,
			cwd: currentAgent.cwd
		} : { scope: currentAgent.scope };
	}
	/** name -> last-good skill body. Replaced only on `ready`; see applyBodies. */
	let bodies = new Map();
	/** True once a pass ran with an agent scope; gates the UI's Remove action. */
	let hasScopedRead = false;
	/** agentId -> skill names stamped in start-only mode. */
	const injectedByAgent = new Map();
	let currentAgentId = null;
	/** Live agent handle (used as the skills lookup scope) + its workspace cwd. */
	let currentAgent = null;
	/**
	* In-flight resolve plus the selection/scope key it was computed from, so
	* concurrent triggers share a pass only when they agree on both.
	*/
	let refreshInFlight = null;
	/** Monotonic pass id: a slower older pass must never commit over a newer one. */
	let passSeq = 0;
	/** Message text of an unknown throw, for a user-facing reason string. */
	function errorText(e) {
		return String(e?.message ?? e);
	}
	/**
	* One classification pass over the current selection. Reads the catalog once
	* (with its completeness flag), loads bodies only for advertised names, then
	* applies the result to the last-good body map.
	*
	* A pass is shared only with a trigger that agrees on the selection and the
	* scope: a save or a newly arrived scope must not inherit rows computed from
	* the previous ones. Only the newest pass may commit bodies, so a pass that
	* settles late cannot speak for a selection it no longer describes.
	*/
	function resolveSelection() {
		const cfg = config();
		const options = lookupOptions();
		const key = (options !== undefined ? "scoped:" : "unscoped:") + cfg.selected.join(",");
		if (refreshInFlight !== null && refreshInFlight.key === key) return refreshInFlight.promise;
		const seq = ++passSeq;
		const promise = (async () => {
			const prevBodies = bodies;
			const scoped = options !== undefined;
			if (scoped) hasScopedRead = true;
			let catalog;
			try {
				const observation = await skills.snapshot(options);
				catalog = {
					kind: "scoped",
					names: observation.skills.map((s) => s.name),
					complete: observation.complete
				};
			} catch (e) {
				catalog = {
					kind: "error",
					reason: errorText(e)
				};
			}
			const advertised = new Set(catalog.kind === "scoped" ? catalog.names : []);
			const loads = new Map();
			const fresh = new Map();
			for (const name$1 of cfg.selected) {
				if (!advertised.has(name$1)) continue;
				try {
					const skill = await skills.get(name$1, options);
					if (skill === undefined || typeof skill.content !== "string") {
						loads.set(name$1, {
							ok: false,
							reason: "skill body could not be loaded"
						});
						continue;
					}
					fresh.set(name$1, {
						name: skill.name,
						description: skill.description,
						content: skill.content,
						provider: skill.provider,
						...skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}
					});
					loads.set(name$1, { ok: true });
				} catch (e) {
					loads.set(name$1, {
						ok: false,
						reason: errorText(e)
					});
				}
			}
			const rows = classifySelection({
				selected: cfg.selected,
				catalog,
				scoped,
				loads
			});
			const nextBodies = applyBodies(prevBodies, rows, fresh);
			if (seq === passSeq) bodies = nextBodies;
			return {
				key,
				mode: cfg.mode,
				selected: cfg.selected,
				rows,
				cached: new Set(nextBodies.keys())
			};
		})().finally(() => {
			if (refreshInFlight !== null && refreshInFlight.promise === promise) refreshInFlight = null;
		});
		refreshInFlight = {
			key,
			promise
		};
		return promise;
	}
	/** Concatenated <skill_content> blocks for the selection (each-prompt path). */
	function renderActiveSkills() {
		const blocks = [];
		for (const name$1 of config().selected) {
			const skill = bodies.get(name$1);
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
	/**
	* Stamp the selected skills this session has not stamped yet. Idempotent:
	* `injectedByAgent` and `alreadyInHistory` make a second call after a later
	* resolve a no-op, which is what lets a cold cache stamp in two passes.
	*/
	function stampSelected(agent) {
		const id = agent.id;
		if (id === undefined || agent.inject === undefined) return;
		if (config().mode !== "start-only") return;
		const stamped = new Set(injectedByAgent.get(id) ?? []);
		for (const name$1 of config().selected) {
			if (stamped.has(name$1)) continue;
			const skill = bodies.get(name$1);
			if (skill === undefined) continue;
			if (alreadyInHistory(agent, name$1)) {
				stamped.add(name$1);
				continue;
			}
			try {
				agent.inject(createUserMessage(buildInjectionMessage(name$1, renderSkillContent(skill))));
				stamped.add(name$1);
			} catch {}
		}
		injectedByAgent.set(id, [...stamped]);
		if (injectedByAgent.size > 200) injectedByAgent.delete(injectedByAgent.keys().next().value);
	}
	ctx.effect(() => c.on("agent/session-start", ({ agent }) => {
		if (agent?.id === undefined || agent.inject === undefined) return;
		currentAgentId = agent.id;
		currentAgent = {
			scope: agent,
			cwd: agent.session?.header?.cwd
		};
		stampSelected(agent);
		void resolveSelection().then(() => stampSelected(agent)).catch(() => {});
	}));
	async function buildSnapshot(pass) {
		let available = [];
		try {
			available = (await skills.list(lookupOptions())).filter(isModelInvocable).map((s) => ({
				name: s.name,
				description: s.description
			}));
		} catch {
			available = [];
		}
		const unresolved = pass.rows.filter((r) => r.state !== "ready").map((r) => ({
			...r,
			cached: pass.cached.has(r.name)
		}));
		return {
			ok: true,
			mode: pass.mode,
			selected: pass.selected,
			available,
			unresolved,
			missing: unresolved.map((u) => u.name),
			injected: currentAgentId !== null ? injectedByAgent.get(currentAgentId) ?? [] : [],
			canRemove: hasScopedRead
		};
	}
	ctx.effect(() => {
		const disposers = [];
		disposers.push(c.on("settings/updated", (ns) => {
			if (ns === NAMESPACE) void resolveSelection();
		}));
		disposers.push(c.on("skills/change", () => void resolveSelection()));
		disposers.push(webServer.register({
			kind: "exact",
			path: "/skill-injector/api",
			handler: async (_req, res) => {
				try {
					const pass = await resolveSelection();
					const body = JSON.stringify(await buildSnapshot(pass));
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
					const pass = await resolveSelection();
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(JSON.stringify(await buildSnapshot(pass)));
				} catch (e) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						ok: false,
						error: String(e?.message ?? e)
					}));
				}
			}
		}));
		void resolveSelection();
		return () => {
			for (const d of disposers) try {
				d();
			} catch {}
		};
	});
}

//#endregion
export { apply, inject, name };