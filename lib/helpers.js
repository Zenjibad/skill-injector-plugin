
//#region src/helpers.ts
const MAX_SELECTED = 16;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODES = ["each-prompt", "start-only"];
function isSkillName(value) {
	return SKILL_NAME.test(value);
}
function validateSelection(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {
		ok: false,
		error: "settings must be an object { mode, selected }"
	};
	const raw = value;
	const mode = raw.mode;
	if (mode !== "each-prompt" && mode !== "start-only") return {
		ok: false,
		error: "mode must be \"each-prompt\" or \"start-only\""
	};
	if (!Array.isArray(raw.selected)) return {
		ok: false,
		error: "selected must be an array of skill names"
	};
	const selected = [];
	for (const name of raw.selected) {
		if (typeof name !== "string" || !isSkillName(name)) return {
			ok: false,
			error: `invalid skill name "${String(name)}" (kebab-case required)`
		};
		if (!selected.includes(name)) selected.push(name);
	}
	if (selected.length > MAX_SELECTED) return {
		ok: false,
		error: `too many skills (max ${MAX_SELECTED})`
	};
	return {
		ok: true,
		config: {
			mode,
			selected
		}
	};
}
function escapePromptBraces(text) {
	return text.replaceAll("{{", "&#123;&#123;");
}
function buildInjectionMessage(name, renderedText) {
	return {
		content: [{
			type: "text",
			text: renderedText
		}],
		source: {
			kind: "skill-invocation",
			name,
			form: "instructions"
		}
	};
}
function classifySelection(input) {
	const { selected, catalog, scoped, loads } = input;
	const advertised = new Set(catalog.kind === "scoped" ? catalog.names : []);
	const complete = catalog.kind === "scoped" && catalog.complete;
	return selected.map((name) => {
		if (advertised.has(name)) {
			const load = loads.get(name);
			if (load !== undefined && load.ok) return {
				name,
				state: "ready"
			};
			return {
				name,
				state: "load-failed",
				reason: load?.reason || "skill body could not be loaded"
			};
		}
		if (catalog.kind === "error") return {
			name,
			state: "unavailable",
			reason: catalog.reason || "skill catalog read failed"
		};
		if (!complete) return {
			name,
			state: "unavailable",
			reason: "provider discovery incomplete"
		};
		if (!scoped) return {
			name,
			state: "no-scope",
			reason: "waiting for a session to establish scope"
		};
		return {
			name,
			state: "unknown",
			reason: "not in the skill catalog"
		};
	});
}
function applyBodies(prev, rows, fresh) {
	const next = new Map();
	for (const row of rows) {
		if (row.state === "unknown") continue;
		const body = row.state === "ready" ? fresh.get(row.name) : prev.get(row.name);
		if (body !== undefined) next.set(row.name, body);
	}
	return next;
}

//#endregion
export { MAX_SELECTED, MODES, applyBodies, buildInjectionMessage, classifySelection, escapePromptBraces, isSkillName, validateSelection };