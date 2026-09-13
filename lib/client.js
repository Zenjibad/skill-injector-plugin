window.__ModuleLoader__.load({ id: "skill-injector-plugin", factory: (require) => {
"use strict";
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
const react = __toESM(require("react"));

//#region src/helpers.ts
function cachedSuffix(input) {
	if (input.cached !== true) return "";
	if (input.mode === "start-only") return input.injected.includes(input.name) ? " · already in this session" : " · last loaded copy retained";
	return " · still injecting the last loaded copy";
}

//#endregion
//#region src/client/index.tsx
const inject = ["slots"];
const POLL_MS = 5e3;
const API = "/skill-injector/api";
const API_CONFIG = "/skill-injector/api/config";
function apply(ctx) {
	const slots = ctx.get("slots");
	if (slots === undefined) return;
	const style = document.createElement("style");
	style.dataset.plugin = "skill-injector-plugin";
	style.textContent = [
		".si-dash{display:flex;flex-direction:column;gap:14px;padding:8px 0;color:var(--dsw-alias-label-primary)}",
		".si-title{font-size:16px;font-weight:600}",
		".si-sub{font-size:12px;opacity:.55}",
		".si-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}",
		".si-item{display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}",
		".si-item input{margin-top:2px}",
		".si-item-name{font-size:13px;font-weight:600}",
		".si-item-desc{font-size:12px;opacity:.6}",
		".si-modes{display:flex;gap:16px;font-size:13px}",
		".si-modes label{display:flex;gap:6px;align-items:center}",
		".si-save{padding:6px 16px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}",
		".si-status{font-size:12px;opacity:.7}",
		".si-error{color:var(--dsw-alias-state-error-primary);font-size:12px}",
		".si-urow{display:flex;align-items:center;gap:8px;font-size:12px}",
		".si-urow>.si-status{flex:1;min-width:0;overflow-wrap:anywhere}",
		".si-mini{padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}",
		".si-mini:disabled{opacity:.5;cursor:default}",
		".si-note{padding:16px;opacity:.7}",
		".si-dock{font-size:12px;opacity:.65;padding:2px 0;white-space:nowrap}"
	].join("");
	document.head.appendChild(style);
	ctx.effect(() => () => {
		style.remove();
	});
	let snapshot = null;
	/** Monotonic request id: a slow response must never overwrite a newer one. */
	let pollSeq = 0;
	const listeners = new Set();
	/** Normalize a host body: this bundle can outlive the host that served it. */
	function normalize(raw) {
		return {
			ok: raw.ok === true,
			error: raw.error,
			mode: raw.mode === "start-only" ? "start-only" : "each-prompt",
			selected: raw.selected ?? [],
			available: raw.available ?? [],
			unresolved: raw.unresolved ?? [],
			injected: raw.injected ?? [],
			canRemove: raw.canRemove === true
		};
	}
	async function poll() {
		const seq = ++pollSeq;
		let next;
		try {
			const res = await fetch(API, { cache: "no-store" });
			if (!res.ok) throw new Error("HTTP " + res.status);
			next = normalize(await res.json());
		} catch (e) {
			next = {
				ok: false,
				error: String(e?.message ?? e),
				mode: "each-prompt",
				selected: [],
				available: [],
				unresolved: [],
				injected: [],
				canRemove: false
			};
		}
		if (seq !== pollSeq) return;
		snapshot = next;
		for (const fn of listeners) fn();
	}
	void poll();
	const timer = setInterval(() => void poll(), POLL_MS);
	ctx.effect(() => () => {
		clearInterval(timer);
		listeners.clear();
	});
	function useSnapshot() {
		const [state, setState] = react.default.useState(snapshot);
		react.default.useEffect(() => {
			const fn = () => setState(snapshot);
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}, []);
		return state;
	}
	function SettingsPanel() {
		const snap = useSnapshot();
		const h = react.default.createElement;
		const [selected, setSelected] = react.default.useState(snap?.selected ?? []);
		const [mode, setMode] = react.default.useState(snap?.mode ?? "each-prompt");
		const [saving, setSaving] = react.default.useState(false);
		const [checking, setChecking] = react.default.useState(false);
		const [error, setError] = react.default.useState(null);
		const [saved, setSaved] = react.default.useState(false);
		react.default.useEffect(() => {
			if (snap === null) return;
			setSelected(snap.selected);
			setMode(snap.mode);
		}, [snap?.mode, JSON.stringify(snap?.selected)]);
		function toggle(name, checked) {
			setSaved(false);
			setSelected((prev) => checked ? [...prev, name] : prev.filter((n) => n !== name));
		}
		async function save(next) {
			setSaving(true);
			setError(null);
			try {
				const res = await fetch(API_CONFIG, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						mode,
						selected: next ?? selected
					})
				});
				const body = await res.json();
				if (!body.ok) throw new Error(body.error ?? "HTTP " + res.status);
				setSaved(true);
				void poll();
			} catch (e) {
				setError(String(e?.message ?? e));
			} finally {
				setSaving(false);
			}
		}
		/** Remove a name the host could not resolve — the only way out of a stale selection. */
		async function remove(name) {
			const next = selected.filter((n) => n !== name);
			setSelected(next);
			setSaved(false);
			await save(next);
		}
		/** Re-run the same refresh the 5s poll performs, with visible feedback. */
		async function retry() {
			setChecking(true);
			setSaved(false);
			try {
				await Promise.all([poll(), new Promise((resolve) => setTimeout(resolve, 400))]);
			} finally {
				setChecking(false);
			}
		}
		if (snap === null) return h("div", { className: "si-note" }, "Loading skills…");
		if (!snap.ok) return h("div", { className: "si-note si-error" }, "Skill Injector unavailable: " + String(snap.error));
		return h("div", { className: "si-dash" }, h("div", { className: "si-title" }, "Skill Injector"), h("div", { className: "si-sub" }, "Inject chosen skills into every session. Choose skills and mode, then Save."), h("div", { className: "si-list" }, snap.available.map((skill) => h("label", {
			key: skill.name,
			className: "si-item"
		}, h("input", {
			type: "checkbox",
			checked: selected.includes(skill.name),
			onChange: (e) => toggle(skill.name, e.target.checked)
		}), h("div", null, h("div", { className: "si-item-name" }, skill.name), h("div", { className: "si-item-desc" }, skill.description))))), snap.unresolved.length > 0 ? h("div", { className: "si-list" }, h("div", { className: "si-sub" }, "Unresolved (" + snap.unresolved.length + "):"), h("ul", { className: "si-list" }, snap.unresolved.map((u) => h("li", {
			key: u.name,
			className: "si-urow"
		}, h("span", { className: "si-item-name" }, u.name), h("span", { className: "si-status" }, (u.reason || u.state) + cachedSuffix({
			mode: snap.mode,
			injected: snap.injected,
			name: u.name,
			cached: u.cached
		})), h("button", {
			className: "si-mini",
			"aria-label": "Retry " + u.name,
			onClick: () => void retry(),
			disabled: checking
		}, checking ? "Checking…" : "Retry"), snap.canRemove ? h("button", {
			className: "si-mini",
			"aria-label": "Remove " + u.name,
			onClick: () => void remove(u.name),
			disabled: saving
		}, "Remove") : null)))) : null, h("div", { className: "si-modes" }, h("label", null, h("input", {
			type: "radio",
			name: "si-mode",
			checked: mode === "each-prompt",
			onChange: () => setMode("each-prompt")
		}), "Inject every prompt"), h("label", null, h("input", {
			type: "radio",
			name: "si-mode",
			checked: mode === "start-only",
			onChange: () => setMode("start-only")
		}), "Inject once at session start")), h("button", {
			className: "si-save",
			onClick: () => void save(),
			disabled: saving
		}, saving ? "Saving…" : "Save"), error !== null ? h("div", { className: "si-error" }, error) : null, saved ? h("div", { className: "si-status" }, "Saved") : null, h("div", { className: "si-status" }, "Active in this session: " + (snap.injected.length > 0 ? snap.injected.join(", ") : "none")));
	}
	function DockLine() {
		const snap = useSnapshot();
		if (snap === null || !snap.ok) return null;
		const names = snap.selected.length > 0 ? snap.selected.join(", ") : "none";
		const unresolved = snap.unresolved.length;
		return react.default.createElement("div", { className: "si-dock" }, "Injected Skills: " + names + " · Mode: " + snap.mode + (unresolved > 0 ? " · " + unresolved + " unresolved" : ""));
	}
	slots.inject("settings.section", () => slots.register({
		name: "settings.section",
		id: "skill-injector",
		order: 60,
		label: "Skill Injector"
	}, () => react.default.createElement(SettingsPanel)));
	slots.inject("conversation.composer.dock", () => slots.register({
		name: "conversation.composer.dock",
		id: "skill-injector-dock",
		order: 10
	}, () => react.default.createElement(DockLine)));
}

//#endregion
exports.apply = apply
exports.inject = inject
return module.exports; } });
//# sourceMappingURL=client.js.map