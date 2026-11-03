import z from "@deepseek-ai/schemastery";
import { isModelInvocable, renderSkillContent } from "@deepseek-ai/dsh-skill";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { applyBodies, buildInjectionMessage, classifySelection, escapePromptBraces, validateSelection } from "./helpers.js";

//#region src/index.ts
const name = "skill-injector-plugin";
/** Loader row name; the profile entry id unless the composition renames it. */
const ENTRY_NAME = "skill-injector-plugin";
const SECTION_NAME = "skill-injector:active";
const SECTION_ORDER = 150;
/** Upper bound on the cold-cache resolve awaited at `agent/created`. */
const STAMP_RESOLVE_DEADLINE_MS = 3e3;
/** Bound on the per-agent stamp ledger. */
const MAX_TRACKED_AGENTS = 200;
const Config = z.object({
	mode: z.union([z.const("each-prompt"), z.const("start-only")]).default("each-prompt").volatile(),
	selected: z.array(z.string()).default([]).volatile()
});
const inject = [
	"webServer",
	"settings",
	"skills",
	"systemPrompt"
];
/** Unwrap a volatile reference, tolerating a plain value (older hosts, tests). */
function readLive(value, fallback) {
	if (value !== null && typeof value === "object" && typeof value.get === "function") {
		const live = value.get();
		return live === undefined ? fallback : live;
	}
	return value ?? fallback;
}
/** Normalize the Loader-supplied Config into a validated InjectorConfig. */
function resolveConfig(raw) {
	const r = validateSelection({
		mode: raw.mode ?? "each-prompt",
		selected: Array.isArray(raw.selected) ? raw.selected : []
	});
	return r.ok ? r.config : {
		mode: "each-prompt",
		selected: []
	};
}
/**
* Resolve with the promise's value, or with `undefined` once `ms` elapses.
* Used to bound the cold-cache resolve awaited inside `agent/created`, which
* is a serial event: a wedged skill scan must never wedge session creation.
*/
function withDeadline(promise, ms) {
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(value);
		};
		timer = setTimeout(() => finish(undefined), ms);
		promise.then((value) => finish(value), () => finish(undefined));
	});
}
function apply(ctx, pluginConfig) {
	const c = ctx;
	const { webServer, settings, skills, systemPrompt } = c;
	/**
	* The live configuration. Both Config fields are volatile, so a settings
	* write commits into the same wrappers and only emits
	* `loader/volatile-update` — reading through the wrappers is what makes a
	* Save take effect without an entry reload (and without losing the body
	* cache or the agent scope).
	*/
	function config() {
		return resolveConfig({
			mode: readLive(pluginConfig?.mode, "each-prompt"),
			selected: readLive(pluginConfig?.selected, [])
		});
	}
	/** This plugin's profile entry id, which is what `settings.update` addresses. */
	const ENTRY_ID = (() => {
		try {
			const rows = (c.get?.("loader"))?.entries?.() ?? [];
			const own = rows.find((row) => row.options?.name === ENTRY_NAME && typeof row.options.id === "string");
			return own?.options?.id ?? ENTRY_NAME;
		} catch {
			return ENTRY_NAME;
		}
	})();
	if (typeof settings.configure === "function") try {
		ctx.effect(() => settings.configure?.({ auto: false }));
	} catch {}
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
	/** Remember the scope a read should use, keeping the injected list truthful. */
	function remember(agent) {
		if (agent === null || agent.id === undefined || agent.inject === undefined) return;
		currentAgent = agent;
		currentAgentId = agent.id;
	}
	/**
	* Recover a live agent from the registry.
	*
	* A volatile save commits in place, but this entry can still be RE-APPLIED
	* (an ordinary config field, a rebuild, a loader reload), and the fresh
	* instance starts with no scope: without this, the settings page would report
	* `no-scope` and an empty catalog until the next session opened. The registry
	* only holds live agents, and `agent/disposed` clears a remembered one, so a
	* recovered scope is never a disposed scope.
	*/
	function discoverAgent() {
		try {
			const get = c.get;
			if (typeof get !== "function") return null;
			const agents = get.call(c, "agents");
			const rows = agents?.list?.() ?? [];
			return rows[rows.length - 1] ?? null;
		} catch {
			return null;
		}
	}
	/** Skill lookups MUST use the live agent's scope: the filesystem provider
	* registers in the agent preset's layer, so a host-global lookup is empty. */
	function lookupOptions() {
		const agent = currentAgent ?? discoverAgent();
		if (agent === null) return undefined;
		remember(agent);
		const cwd = agent.session?.header?.cwd;
		return cwd !== undefined ? {
			scope: agent,
			cwd
		} : { scope: agent };
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
			for (const skillName of cfg.selected) {
				if (!advertised.has(skillName)) continue;
				try {
					const skill = await skills.get(skillName, options);
					if (skill === undefined || typeof skill.content !== "string") {
						loads.set(skillName, {
							ok: false,
							reason: "skill body could not be loaded"
						});
						continue;
					}
					fresh.set(skillName, {
						name: skill.name,
						description: skill.description,
						content: skill.content,
						provider: skill.provider,
						...skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}
					});
					loads.set(skillName, { ok: true });
				} catch (e) {
					loads.set(skillName, {
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
		for (const skillName of config().selected) {
			const skill = bodies.get(skillName);
			if (skill === undefined) continue;
			blocks.push(escapePromptBraces(renderSkillContent(skill)));
		}
		return blocks.join("\n\n");
	}
	/**
	* This session's own event log. DSH >= 0.2 replaced the public `events`
	* getter with `ownEvents()`; both the deprecated `snapshotEvents()` and the
	* pre-0.2 `events` array are kept as fallbacks so dedupe keeps working across
	* the hosts this plugin can run on.
	*/
	function historyEvents(agent) {
		try {
			const session = agent.session;
			if (session === undefined) return [];
			if (typeof session.ownEvents === "function") return session.ownEvents() ?? [];
			if (typeof session.snapshotEvents === "function") return session.snapshotEvents() ?? [];
			return Array.isArray(session.events) ? session.events : [];
		} catch {
			return [];
		}
	}
	/** True when the session log already carries a stamped skill-invocation for `name`. */
	function alreadyInHistory(agent, skillName) {
		try {
			return historyEvents(agent).some((e) => e.type === "user/message" && e.data?.source?.kind === "skill-invocation" && e.data.source.name === skillName);
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
		const cfg = config();
		if (cfg.mode !== "start-only") return;
		const stamped = new Set(injectedByAgent.get(id) ?? []);
		for (const skillName of cfg.selected) {
			if (stamped.has(skillName)) continue;
			const skill = bodies.get(skillName);
			if (skill === undefined) continue;
			if (alreadyInHistory(agent, skillName)) {
				stamped.add(skillName);
				continue;
			}
			try {
				agent.inject(createUserMessage(buildInjectionMessage(skillName, renderSkillContent(skill))));
				stamped.add(skillName);
			} catch {}
		}
		injectedByAgent.set(id, [...stamped]);
		if (injectedByAgent.size > MAX_TRACKED_AGENTS) injectedByAgent.delete(injectedByAgent.keys().next().value);
	}
	/**
	* start-only: stamp once per selected skill, deduped against this process's
	* stamps and the session history.
	*
	* `agent/created` is a SERIAL event on DSH >= 0.2 and its listeners are
	* awaited before creation resolves, with queued input held until they finish.
	* Pass 1 stamps whatever the cache already holds; pass 2 awaits a scoped
	* resolve for a cold cache and stamps the remainder, so the injected context
	* is in the inbox before the first turn instead of racing it. A failed or
	* slow resolve is contained — session creation must never depend on it.
	*/
	function onAgentCreated(agent) {
		try {
			if (agent === undefined || agent.id === undefined || agent.inject === undefined) return;
			remember(agent);
			stampSelected(agent);
			if (config().mode !== "start-only") return;
			return withDeadline(resolveSelection(), STAMP_RESOLVE_DEADLINE_MS).then(() => {
				try {
					stampSelected(agent);
				} catch {}
			}).catch(() => {});
		} catch {
			return;
		}
	}
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
	function json(res, status, body) {
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		});
		res.end(JSON.stringify(body));
	}
	async function readBody(req) {
		const chunks = [];
		for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		return Buffer.concat(chunks).toString("utf8");
	}
	/** Register a route without letting a duplicate tear down the whole entry. */
	function registerRoute(path, handler) {
		try {
			return webServer.register({
				kind: "exact",
				path,
				handler
			});
		} catch (e) {
			try {
				c.logger?.warn?.(`[skill-injector] could not register ${path}: ${errorText(e)}`);
			} catch {}
			return () => {};
		}
	}
	ctx.effect(() => {
		const disposers = [];
		disposers.push(c.on("loader/volatile-update", () => void resolveSelection()));
		disposers.push(c.on("settings/document-updated", (ns) => {
			if (ns === ENTRY_ID) void resolveSelection();
		}));
		disposers.push(c.on("skills/change", () => void resolveSelection()));
		disposers.push(c.on("agent/created", (payload) => onAgentCreated(payload?.agent)));
		disposers.push(c.on("agent/disposed", (payload) => {
			if (payload?.agent !== undefined && payload.agent === currentAgent) {
				currentAgent = null;
				currentAgentId = null;
			}
		}));
		disposers.push(registerRoute("/skill-injector/api", async (_req, res) => {
			try {
				const pass = await resolveSelection();
				json(res, 200, await buildSnapshot(pass));
			} catch (e) {
				json(res, 500, {
					ok: false,
					error: errorText(e)
				});
			}
		}));
		disposers.push(registerRoute("/skill-injector/api/config", async (req, res) => {
			try {
				const bodyText = await readBody(req);
				let parsed;
				try {
					parsed = JSON.parse(bodyText);
				} catch {
					json(res, 400, {
						ok: false,
						error: "request body must be JSON"
					});
					return;
				}
				const r = validateSelection(parsed);
				if (!r.ok) {
					json(res, 400, {
						ok: false,
						error: r.error
					});
					return;
				}
				await settings.update(ENTRY_ID, r.config);
				void resolveSelection();
				json(res, 200, {
					ok: true,
					mode: r.config.mode,
					selected: r.config.selected
				});
			} catch (e) {
				json(res, 500, {
					ok: false,
					error: errorText(e)
				});
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
export { Config, apply, inject, name };