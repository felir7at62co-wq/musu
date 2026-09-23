import z from "@deepseek-ai/schemastery";
//#region lib/types/settings.js
/**
* The short-drama settings section: the durable fields the Web Settings page
* edits and the drama pipeline reads.
*
* Both compiler faces share this module. The Host half registers
* {@link DramaSettingsSchema} with the settings service; the browser half reads
* the resolved section over the settings transport and compiles its edits back
* into path operations, so the defaults declared here are also what the page
* shows as a field's reset value.
*
* Paid calls are automatically allowed up to the per-drama budget without
* per-call or first-use confirmation; zero disables them. Which catalogue row
* the paid image route buys from is a different question — the account lists
* `gpt-image-2` once per platform at its own price, and nothing here may pick one
* of them on the deployment's behalf, so {@link DramaSettings.imageStandardId}
* carries that choice and the paid call reads it.
*
* The defaults are machine paths and a delivery spec a deployment is expected to
* change in the settings document. They are the schema's own defaults rather
* than composition config: one home per fact, reachable from the page.
*
* @module @deepseek-ai/dsh-drama-settings/src/settings
*/
/** Settings namespace owned by this plugin. */
const DRAMA_SETTINGS_NAMESPACE = "drama";
/** The one field carrying the delivery spec. */
const DELIVERY_SPEC_FIELD = "deliverySpec";
/** No installed JianyingPro draft root can be assumed on another machine. */
const DEFAULT_JIANYING_DRAFT_DIR = "";
/**
* Where a downloaded BGM track lands when the section declares no directory.
*
* Empty means no local library: `bgm_match` searches the published catalogue and
* downloads the one chosen track into its own cache, so nothing here points at a
* folder that has to be kept in sync.
*/
const DEFAULT_BGM_DIR = "";
/** Delivery target of a finished episode when the section declares none. */
const DEFAULT_DELIVERY_SPEC = {
	width: 1440,
	height: 2560,
	fps: 60,
	minBitrateMbps: 4.6
};
/** Every field's value while the settings document holds no override for it. */
const DRAMA_SETTINGS_DEFAULTS = {
	deliveryDir: "",
	jianyingDraftDir: "",
	deliverySpec: DEFAULT_DELIVERY_SPEC,
	bgmDir: "",
	seriesBudgetCents: 4e5
};
/**
* Durable short-drama schema, and the wire envelope the browser scope validates
* its section against. A section absent from a layer resolves to
* {@link DRAMA_SETTINGS_DEFAULTS}; the paths are plain strings because a blank
* one leaves the schema default, including an unconfigured Jianying draft root.
*/
const DramaSettingsSchema = z.object({
	deliveryDir: z.string().default(DRAMA_SETTINGS_DEFAULTS.deliveryDir),
	jianyingDraftDir: z.string().default(""),
	[DELIVERY_SPEC_FIELD]: z.object({
		width: z.number().step(1).min(1).default(DEFAULT_DELIVERY_SPEC.width),
		height: z.number().step(1).min(1).default(DEFAULT_DELIVERY_SPEC.height),
		fps: z.number().step(1).min(1).max(240).default(DEFAULT_DELIVERY_SPEC.fps),
		minBitrateMbps: z.number().min(.1).default(DEFAULT_DELIVERY_SPEC.minBitrateMbps)
	}),
	bgmDir: z.string().default(""),
	imageStandardId: z.number().step(1).min(1),
	seriesBudgetCents: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DRAMA_SETTINGS_DEFAULTS.seriesBudgetCents)
});
//#endregion
//#region lib/types/index.js
/**
* Short-drama settings: one plugin row that owns the `drama` settings namespace
* for both halves of the GUI.
*
* The Host half is this module. It registers {@link DramaSettingsSchema} with
* the settings service and nothing else: the durable values of the short-drama
* pipeline — the delivery and draft directories, the delivery spec and the BGM
* library — live in the DSH settings document, so the Settings page and every
* future reader (the renderer, the delivery step) resolve the same section
* through one seam.
*
* The row publishes no service and reads none: `settings` is acquired through
* `ctx.inject`, so a composition without a settings provider simply mounts
* nothing, and the browser half reports the namespace as unavailable instead of
* inventing a value.
*
* @module @deepseek-ai/dsh-drama-settings
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "drama-settings";
/**
* Register the durable short-drama section, when a settings provider is
* composed.
*
* The registration is an effect on this row's fiber: unloading the row removes
* the namespace, and a stored section that no longer satisfies the schema warns
* and keeps the last good value rather than stranding the page.
* @param ctx - Host context that may acquire the settings service.
*/
function apply(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema);
	});
}
//#endregion
export { DEFAULT_BGM_DIR, DEFAULT_DELIVERY_SPEC, DEFAULT_JIANYING_DRAFT_DIR, DELIVERY_SPEC_FIELD, DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_NAMESPACE, DramaSettingsSchema, apply, name };
