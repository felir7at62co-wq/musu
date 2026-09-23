import { isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
//#region lib/types/config.js
/**
* Deployment paths for the emotion model.
*
* The interpreter is configuration, never a model parameter: a model must not be
* able to point this plugin at an arbitrary executable. Resolution order is an
* explicit configuration value, then the environment variable, and nothing else —
* a silently guessed interpreter would turn a deployment mistake into a confusing
* runtime failure much later.
*
* Registration resolves paths without requiring model resources. Only index and
* inspect start Python; match/download use local or public data without a model.
*/
/**
* Resolve optional public-library settings and reject invalid deployment values.
* @param config - Plugin configuration, never model-supplied URLs or paths.
* @returns Validated remote settings, or undefined for local-index mode.
*/
function resolveCatalogConfig(config) {
	if (config.catalogUrl === void 0) return void 0;
	const url = new URL(config.catalogUrl);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href !== config.catalogUrl) throw new Error("catalogUrl must be a canonical public HTTPS URL without credentials, query or fragment");
	const resolved = {
		catalogUrl: url.href,
		cacheDir: config.cacheDir ?? dshHomePath("perception", "bgm", "cache"),
		networkTimeoutMs: config.networkTimeoutMs ?? 6e4,
		maxCatalogBytes: config.maxCatalogBytes ?? 2 * 1024 * 1024,
		maxTrackBytes: config.maxTrackBytes ?? 128 * 1024 * 1024
	};
	if (!isAbsolute(resolved.cacheDir)) throw new Error("cacheDir must be absolute");
	for (const key of [
		"networkTimeoutMs",
		"maxCatalogBytes",
		"maxTrackBytes"
	]) if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1) throw new Error(`${key} must be a positive safe integer`);
	if (resolved.networkTimeoutMs > 2147483647) throw new Error("networkTimeoutMs exceeds the timer limit");
	return resolved;
}
/** Deployment environment variable supplying the analysis interpreter path. */
const PYTHON_ENV_VAR = "DSH_PERCEPTION_PYTHON";
/** Deployment environment variable supplying the emotion-head checkpoint path. */
const WEIGHTS_ENV_VAR = "DSH_PERCEPTION_BGM_WEIGHTS";
/**
* Locate the emotion head cache when no path is configured.
* @returns The checkpoint path under the harness home; the file need not exist yet.
*/
function defaultWeightsPath() {
	return dshHomePath("perception", "bgm", "J_all.ckpt");
}
/**
* Where the analysed-track index lives by default.
*
* Under the harness home, not inside the package: the index is user data that a
* fresh install must not carry, that an upgrade must not overwrite, and that a
* read-only package install could not accept at all. It is also shared across
* sessions, which is what makes one indexing run reusable by the next.
* @returns The writable-location convention under the harness home; no file is created.
*/
function defaultIndexPath() {
	return dshHomePath("perception", "bgm", "bgm-index.json");
}
/**
* Resolve the interpreter.
* @param configured - Value from plugin configuration.
* @returns An absolute existing path, or an empty string when none is usable.
*/
function resolvePython(configured) {
	const candidate = configured ?? process.env["DSH_PERCEPTION_PYTHON"];
	if (candidate === void 0 || candidate.trim() === "") return "";
	return isAbsolute(candidate) && existsSync(candidate) ? candidate : "";
}
/**
* Resolve the emotion head checkpoint.
* @param configured - Value from plugin configuration.
* @returns The configured path when it exists, otherwise the cache location.
*/
function resolveWeights(configured) {
	const candidate = configured ?? process.env["DSH_PERCEPTION_BGM_WEIGHTS"];
	if (candidate !== void 0 && isAbsolute(candidate) && existsSync(candidate)) return candidate;
	return defaultWeightsPath();
}
//#endregion
export { PYTHON_ENV_VAR, WEIGHTS_ENV_VAR, defaultIndexPath, defaultWeightsPath, resolveCatalogConfig, resolvePython, resolveWeights };
