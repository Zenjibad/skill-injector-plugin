
//#region src/index.ts
const name = "skill-injector-plugin";
const inject = [
	"webServer",
	"settings",
	"skills",
	"systemPrompt"
];
function apply(ctx) {
	void ctx;
}

//#endregion
export { apply, inject, name };