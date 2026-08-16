
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

//#endregion
export { MAX_SELECTED, MODES, buildInjectionMessage, escapePromptBraces, isSkillName, validateSelection };