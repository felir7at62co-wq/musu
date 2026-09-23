import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
//#region lib/types/shot-script.js
/**
* Structural checks for shot scripts and matched JSON written through file tools.
* Creative pacing and voice guidance is reported by `drama_shot`, not refused here.
* @module @deepseek-ai/dsh-guard-drama/src/shot-script
*/
/** Han, Latin letters, and digits used by the advisory speech estimate. */
const EFFECTIVE_CHARACTER = /[\u4e00-\u9fffA-Za-z0-9]/g;
/**
* Count effective characters without changing the spoken text.
* @param text - Spoken text.
* @returns Han characters, Latin letters and digits counted.
*/
function countEffectiveChars(text) {
	return text.match(EFFECTIVE_CHARACTER)?.length ?? 0;
}
/**
* Estimate whole seconds at nine effective characters per second; not a duration requirement.
* @param effectiveChars - Effective character count.
* @returns Estimated seconds, at least one.
*/
function requiredSeconds(effectiveChars) {
	return Math.max(1, Math.ceil(effectiveChars / 9));
}
/**
* Reject malformed explicit durations; omitted durations are derived by the compiler.
* @param text - Complete shot-script text.
* @returns Structural failure guidance, or undefined.
*/
function checkShotScriptText(text) {
	for (const match of text.matchAll(/^[ \t]*时长[：:][ \t]*(.*?)[ \t]*$/gm)) {
		const declared = match[1] ?? "";
		if (!/^[1-9]\d*秒$/.test(declared) || !Number.isSafeInteger(Number(declared.slice(0, -1)))) return `时长「${declared}」不合法：明确声明时长时必须是正整数秒，例如「时长：20秒」；也可省略，由 drama_shot 估算。`;
	}
}
/**
* Reject malformed matched JSON or non-positive/non-integer shot durations.
* Provider limits are checked when compiling with an explicit package budget and before submission.
* @param text - Complete matched/package JSON text.
* @returns Structural failure guidance, or undefined.
*/
function checkMatchedJsonText(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "matched JSON 不是合法 JSON；请修复语法后重写。";
	}
	const shots = Array.isArray(parsed) ? parsed : record$1(parsed)?.["shots"];
	if (!Array.isArray(shots)) return "matched JSON 必须有 shots 数组。";
	for (const entry of shots) {
		const shot = record$1(entry);
		if (shot === void 0) return "matched JSON 的每个镜头必须是对象。";
		const duration = shot["script_duration"] ?? shot["duration"];
		if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 1) return "matched JSON 的镜头时长必须是正整数秒；请修正 script_duration/duration。";
		if (shot["text"] !== void 0 && typeof shot["text"] !== "string") return "matched JSON 的台词 text 必须是字符串，保留原文。";
	}
}
/** Narrow parsed JSON to a record. */
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
//#endregion
//#region lib/types/rules.js
/**
* The drama pipeline's decidable gate rules.
*
* Every rule here is answerable from the tool name, its parsed arguments, and
* files this plugin may read. A rule that needed pixels, taste, or a judgement
* about the story is deliberately absent: the gate's whole value is that a
* refusal is a fact the model can act on, and a gate that guessed would block
* correct work. What is not decidable at this granularity is recorded in the
* package README instead of being approximated here.
*
* @module @deepseek-ai/dsh-guard-drama/src/rules
*/
/** Jubian methods that write or bill, and therefore require an idempotency key. */
const WRITE_METHODS = {
	jubian_model: ["apply"],
	jubian_storyboard: [
		"create",
		"save",
		"generate",
		"erase_subtitle"
	],
	jubian_video: ["image_generate", "upscale"],
	jubian_asset: ["confirm_casting", "remove"]
};
/** Jubian methods that spend money on the storyboard, which may only follow confirmed official assets. */
const PAID_SUBMISSIONS = { jubian_storyboard: ["generate"] };
/** Jubian methods that create a new billed asset, which may only follow a reconcile of the project. */
const ASSET_CREATIONS = { jubian_video: ["image_generate"] };
/** The retired MUSE tool names the drama skills replaced; they resolve to nothing in this deployment. */
const RETIRED_TOOL_NAMES = [
	"drama",
	"asset",
	"shot",
	"project",
	"timeline",
	"delivery"
];
/** File-writing tools whose full written text the content rules inspect by name. */
const WRITE_TOOL = "write";
const EDIT_TOOL = "edit";
/** The canonical project artifacts the official-asset gate reads. */
const ASSETS_MANIFEST = "assets_manifest.json";
/** Project file that binds a directory to one Jubian project. */
const PROJECT_CONFIG = "project_config.json";
const PIPELINE_STATE = "pipeline_state.json";
/** The stage whose completion is accepted as official-asset evidence when no manifest exists. */
const OFFICIAL_STAGE = "official_assets";
/** Where the pipeline's read-only reconcile tool writes its evidence, below one project root. */
const RECONCILE_PROBE_DIR = "_probe";
const RECONCILE_FILE = "asset-reconcile.json";
/** That same evidence path as the pipeline's own commands spell it, for the refusal text. */
const RECONCILE_LABEL = `${RECONCILE_PROBE_DIR}/${RECONCILE_FILE}`;
/** How old reconcile evidence may be before a new billed asset needs a fresh reconcile. */
const RECONCILE_FRESH_HOURS = 24;
/** An ISO date-time carrying no zone, which the pipeline's tool writes and reads as China Standard Time. */
const NAIVE_STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
/** China Standard Time, the zone a naive evidence timestamp is read in. */
const CN_OFFSET = "+08:00";
/**
* Judge one pending tool call.
* @param call - the tool name, its arguments, and the injected readers and switches.
* @returns `allow`, or a `deny` whose reason is the Chinese repair instruction the model reads.
*/
function evaluateCall(call) {
	const reason = [
		call.switches.museToolNames ? retiredToolRefusal(call) : void 0,
		call.switches.idempotencyKey ? idempotencyRefusal(call) : void 0,
		call.switches.reconcileFirst ? reconcileRefusal(call) : void 0,
		call.switches.officialAssets ? officialAssetRefusal(call) : void 0,
		call.switches.shotScript ? shotContentRefusal(call) : void 0
	].find((refusal) => refusal !== void 0);
	return reason === void 0 ? { kind: "allow" } : {
		kind: "deny",
		reason
	};
}
/** Refuse a call to a retired MUSE tool name with the replacement surface, never a bare unknown-tool error. */
function retiredToolRefusal(call) {
	if (call.registered || !RETIRED_TOOL_NAMES.includes(call.toolName)) return void 0;
	return `没有名为「${call.toolName}」的工具：这是已下线的 MUSE 工具名，本模式不再提供。请改用剧变工具（jubian_catalog / jubian_asset / jubian_storyboard / jubian_video / jubian_media）以及 tweet-drama-* 技能脚本。`;
}
/** Refuse a Jubian write/paid method that carries no usable idempotency key. */
function idempotencyRefusal(call) {
	const methods = WRITE_METHODS[call.toolName];
	const method = calledMethod(call);
	if (methods === void 0 || method === void 0 || !methods.includes(method)) return void 0;
	const key = record(call.arguments)?.["idempotency_key"];
	if (typeof key === "string" && key.trim().length > 0) return void 0;
	return `${call.toolName}.${method} 是写/计费方法，必须带 idempotency_key。补上 idempotency_key 后重发；如果上一次调用的结果不明，用同一个 key 再调一次，不要换 key 重发。`;
}
/** Refuse a paid storyboard submission while its own project holds no official asset record. */
function officialAssetRefusal(call) {
	const methods = PAID_SUBMISSIONS[call.toolName];
	const method = calledMethod(call);
	if (methods === void 0 || method === void 0 || !methods.includes(method)) return void 0;
	const workspace = workspaceRoot(call);
	if (workspace === void 0) return unboundRefusal(call, method, "找不到工作目录");
	const project = operationProject(call, resolve(workspace, call.workshopDir));
	if (project === void 0) return unboundRefusal(call, method, "这次调用没有说明它属于哪个项目");
	if (hasOfficialAssetEvidence([project], call.reader)) return void 0;
	return `${call.toolName}.${method} 会真实计费，但这个项目里找不到 official=true 的正式资产记录（已查：${project}）。镜头与视频只能引用 official=true 且有剧变 asset/material id 与 URL 的资产；先走资产三阶段门禁（写提示词 → 生图 → 候选审核 → 确认出演 / isLocal 主体设定门禁），把 official 记录写进该项目的 assets_manifest.json 后再提交。`;
}
/**
* Refuse a side-effecting call the gate cannot bind to one project.
*
* The check used to pass whenever *any* project in the workshop carried the evidence,
* so one project's manifest could authorize another project's paid call. Binding by the
* operation is what makes the evidence mean what it says; a call the gate cannot place
* is refused with the two ways to place it rather than allowed on a guess.
*/
function unboundRefusal(call, method, cause) {
	return `${call.toolName}.${method} 会真实计费或改变项目内容，但${cause}，门禁无法核对它引用的资产。请在调用里给出 project_dir（项目根目录）或 script_id（剧变项目 ID），让本次操作绑定到一个具体项目后重试；普通查询与草稿编辑不受此限制。`;
}
/**
* Refuse creating a new billed asset while the project holds no usable reconcile
* of what the remote project already contains. The manifest records what this
* pipeline generated, not what the project has, so a model reading only the
* manifest regenerates an asset that is already there and selected.
*/
function reconcileRefusal(call) {
	const methods = ASSET_CREATIONS[call.toolName];
	const method = calledMethod(call);
	if (methods === void 0 || method === void 0 || !methods.includes(method)) return void 0;
	const workspace = workspaceRoot(call);
	if (workspace === void 0) return unboundRefusal(call, method, "找不到工作目录");
	const project = operationProject(call, resolve(workspace, call.workshopDir));
	if (project === void 0) return unboundRefusal(call, method, "这次调用没有说明它属于哪个项目");
	const state = reconcileState(join(project, RECONCILE_PROBE_DIR, RECONCILE_FILE), call.reader);
	if (state.kind === "ready") return void 0;
	return `${call.toolName}.${method} 会新建资产并真实计费，但先要有本项目的资产对账证据：${describeReconcile(state)}（已查：${project}）。清单只记录我们生成过什么，不等于剧变项目里已经有什么；先在项目根跑一次对账：\`python _tools/asset_reconcile.py\`。对账列出的「远端已选用、清单里没有」的资产不要重新生成，登记进 assets_manifest.json 复用；确认不需要的写明原因：\`python _tools/asset_reconcile.py --dispose <asset_id> --status ignored --note "为什么不需要"\`。证据 ${RECONCILE_FRESH_HOURS} 小时内有效，ready=true 且 blocking 与 ignored_without_note 都为空才放行。`;
}
/**
* Judge one project's reconcile evidence, mirroring the pipeline tool's own
* `evidence_state`: the file must parse, its `ran_at` must be at most
* {@link RECONCILE_FRESH_HOURS} old and not more than {@link RECONCILE_FUTURE_MINUTES}
* ahead, and it must report no undisposed unregistered asset, no ignored asset
* without a note, and `ready: true`.
*/
function reconcileState(path, reader) {
	const text = reader.readText(path);
	if (text === void 0) return { kind: "absent" };
	const report = record(parsedJson(text));
	if (report === void 0) return {
		kind: "unusable",
		why: `${RECONCILE_LABEL} 不是可解析的对账 JSON`
	};
	const ranAt = report["ran_at"];
	const instant = ranAtInstant(ranAt);
	if (instant === void 0) return {
		kind: "unusable",
		why: "对账证据的 ran_at 缺失或不是 ISO 时间"
	};
	const age = Date.now() - instant;
	if (age > RECONCILE_FRESH_HOURS * 60 * 60 * 1e3) return {
		kind: "unusable",
		why: `对账已过期（${String(ranAt)}，超过 ${RECONCILE_FRESH_HOURS} 小时）`
	};
	if (age < -300 * 1e3) return {
		kind: "unusable",
		why: `对账时间在未来（${String(ranAt)}）`
	};
	const blocking = nonEmptyList(report["blocking"]);
	if (blocking !== void 0) return {
		kind: "unusable",
		why: `对账里还有 ${blocking.length} 条未处置的未登记资产：${blocking.join("、")}`
	};
	const ignored = nonEmptyList(report["ignored_without_note"]);
	if (ignored !== void 0) return {
		kind: "unusable",
		why: `有 ${ignored.length} 条判为 ignored 但没写 note：${ignored.join("、")}`
	};
	if (report["ready"] !== true) return {
		kind: "unusable",
		why: "对账未标记 ready"
	};
	return { kind: "ready" };
}
/** The instant one `ran_at` value denotes, or undefined when it is not a timestamp at all. */
function ranAtInstant(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	const stamp = NAIVE_STAMP.test(trimmed) ? `${trimmed.replace(" ", "T")}${CN_OFFSET}` : trimmed;
	const instant = Date.parse(stamp);
	return Number.isNaN(instant) ? void 0 : instant;
}
/** The non-empty list one evidence field carries, or undefined when it is empty, absent, or not a list. */
function nonEmptyList(value) {
	return Array.isArray(value) && value.length > 0 ? value : void 0;
}
/** One state's shortcoming: why its evidence is unusable, else that it is missing. */
function describeReconcile(state) {
	return state.kind === "unusable" ? state.why : `没有 ${RECONCILE_LABEL}`;
}
/** Refuse a write/edit whose resulting text would violate the shot-script or matched-JSON contract. */
function shotContentRefusal(call) {
	if (call.toolName !== WRITE_TOOL && call.toolName !== EDIT_TOOL) return void 0;
	const workspace = workspaceRoot(call);
	if (workspace === void 0) return void 0;
	const args = record(call.arguments);
	const filePath = args?.["file_path"];
	if (args === void 0 || typeof filePath !== "string" || filePath.trim().length === 0) return void 0;
	const target = isAbsolute(filePath) ? resolve(filePath) : resolve(workspace, filePath);
	const kind = shotTarget(resolve(workspace, call.workshopDir), target);
	if (kind === void 0) return void 0;
	const text = call.toolName === WRITE_TOOL ? writtenText(args) : editedText(args, call.reader, target);
	if (text === void 0) return void 0;
	const refusal = kind === "script" ? checkShotScriptText(text) : checkMatchedJsonText(text);
	if (refusal === void 0) return void 0;
	return `短剧门禁拦下这次 ${call.toolName}（${target}）：${refusal}`;
}
/** The text a `write` call would commit, or undefined when the argument is not a string. */
function writtenText(args) {
	const content = args["content"];
	return typeof content === "string" ? content : void 0;
}
/**
* The text an `edit` call would commit, reconstructed from the file it names.
* The reconstruction mirrors the tool's own literal semantics exactly — a
* `split`/`join` with no `$&` expansion, a single match required unless
* `replace_all` is set — and an edit the tool itself would refuse (a missing or
* ambiguous match, an unreadable target) yields no text to judge, because
* nothing would be written.
*/
function editedText(args, reader, path) {
	const oldString = args["old_string"];
	const newString = args["new_string"];
	if (typeof oldString !== "string" || typeof newString !== "string" || oldString.length === 0) return void 0;
	const current = reader.readText(path);
	if (current === void 0) return void 0;
	const occurrences = current.split(oldString).length - 1;
	if (occurrences === 0 || args["replace_all"] !== true && occurrences > 1) return void 0;
	return current.split(oldString).join(newString);
}
/** Classify a path below the workshop as a gated shot script or matched JSON, or neither. */
function shotTarget(workshopRoot, target) {
	const rel = relative(workshopRoot, target);
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return void 0;
	const segments = rel.split(/[\\/]/);
	const base = (segments.at(-1) ?? "").toLowerCase();
	if (!segments.slice(0, -1).some((segment) => [
		"prompts",
		"matches",
		"episode_packages"
	].includes(segment.toLowerCase()))) return void 0;
	if (base.endsWith(".matched.json") || base === "matched.json" || base === "package.json") return "matched";
	return base.endsWith(".txt") ? "script" : void 0;
}
/** The tool's `method` argument, normalized, or undefined when the call states none. */
function calledMethod(call) {
	const method = record(call.arguments)?.["method"];
	if (typeof method !== "string") return void 0;
	const normalized = method.trim().toLowerCase();
	return normalized.length === 0 ? void 0 : normalized;
}
/**
* The one project a call operates on, resolved from the call itself.
*
* In order: an explicit `projectRoot` the caller injected, then the call's own
* `project_dir` argument, then the project among the workshop's children whose
* `project_config.json` declares the `script_id` the call names. Nothing here
* searches sideways — a call that names no project yields no project, which is what
* stops one project's evidence from authorizing another project's operation.
* @param call - The pending call and its readers.
* @param workshopRoot - Directory holding the drama projects.
* @returns The project root, or undefined when the call does not identify one.
*/
function operationProject(call, workshopRoot) {
	const explicit = call.projectRoot;
	if (typeof explicit === "string" && explicit.trim().length > 0 && isAbsolute(explicit)) return resolve(explicit);
	const args = record(call.arguments);
	const directory = args?.["project_dir"];
	if (typeof directory === "string" && directory.trim().length > 0) return isAbsolute(directory) ? resolve(directory) : resolve(workshopRoot, directory);
	const wanted = Number(args?.["script_id"]);
	if (args?.["script_id"] !== void 0 && Number.isFinite(wanted)) for (const name of call.reader.listDirectoryNames(workshopRoot)) {
		const candidate = resolve(workshopRoot, name);
		if (projectScriptId(join(candidate, PROJECT_CONFIG), call.reader) === wanted) return candidate;
	}
}
/** The project id one `project_config.json` declares, or undefined when it names none. */
function projectScriptId(path, reader) {
	const declared = Number(record(parsedJson(reader.readText(path)))?.["jubian_script_id"]);
	return Number.isFinite(declared) ? declared : void 0;
}
/** The root the gate resolves paths against: the session's stated cwd, then the configured fallback. */
function workspaceRoot(call) {
	const stated = call.sessionCwd;
	if (typeof stated === "string" && stated.trim().length > 0 && isAbsolute(stated)) return resolve(stated);
	const configured = call.configuredRoot;
	if (typeof configured === "string" && configured.trim().length > 0 && isAbsolute(configured)) return resolve(configured);
}
/** Whether any candidate root carries an official-asset record, preferring a manifest over a state file. */
function hasOfficialAssetEvidence(roots, reader) {
	if (roots.some((root) => manifestHasOfficial(join(root, ASSETS_MANIFEST), reader))) return true;
	return roots.some((root) => stateReportsOfficialAssets(join(root, PIPELINE_STATE), reader));
}
/** Whether `assets_manifest.json` carries at least one `official: true` asset record. */
function manifestHasOfficial(path, reader) {
	const parsed = parsedJson(reader.readText(path));
	const container = Array.isArray(parsed) ? parsed : record(parsed)?.["assets"];
	return (Array.isArray(container) ? container : Object.values(record(container) ?? {})).some((entry) => record(entry)?.["official"] === true);
}
/** Whether `pipeline_state.json` records the official-asset stage as completed for the project or an episode. */
function stateReportsOfficialAssets(path, reader) {
	const parsed = record(parsedJson(reader.readText(path)));
	if (parsed === void 0) return false;
	const episodes = record(parsed["episodes"]);
	return stageStatus(record(parsed["stages"])?.[OFFICIAL_STAGE]) === "completed" || episodes !== void 0 && Object.values(episodes).some((episode) => stageStatus(record(episode)?.[OFFICIAL_STAGE]) === "completed");
}
/** The `status` one optional stage record carries. */
function stageStatus(stage) {
	return record(stage)?.["status"];
}
/** Parse one optional JSON document, treating unreadable or malformed text as absent. */
function parsedJson(text) {
	if (text === void 0) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** Narrow one parsed JSON value to a string-keyed record. */
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
//#endregion
//#region lib/types/index.js
/**
* Drama gate: the short-drama pipeline's hard rules as a tool-dispatch
* interceptor rather than prompt discipline.
*
* `tools/pre-execute` hands this plugin the tool name and the already-parsed
* arguments, and a host-plane plugin may read files, so the rules that are
* genuinely decidable live here: a paid Jubian method must carry an idempotency
* key, a write into the workshop's shot scripts and matched JSON must use
* structurally valid duration fields and JSON, a paid storyboard submission must follow a recorded
* `official=true` asset, and creating a new billed asset must follow a fresh,
* fully disposed reconcile of the project against the remote project's
* already-selected assets. Everything that needs pixels, taste, or a judgement
* about the story stays in the shot-script skill.
*
* The plugin is a preset row: it is mounted for the drama session only, so no
* other conversation pays for the checks. What it cannot decide is recorded in
* the package README.
*
* @module @deepseek-ai/dsh-guard-drama
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "drama-gate";
/**
* Hard dependency. `tools` owns the `tools/pre-execute` waterfall this plugin
* intercepts and the registry view it consults before explaining a retired tool
* name; without it there is nothing to gate.
*/
const inject = ["tools"];
const Config = z.object({
	workspaceRoot: z.string().default(""),
	workshopDir: z.string().default("short-drama"),
	projectRoot: z.string().default(""),
	idempotencyKey: z.boolean().default(true),
	shotScript: z.boolean().default(true),
	officialAssets: z.boolean().default(true),
	reconcileFirst: z.boolean().default(true),
	museToolNames: z.boolean().default(true)
});
/**
* The production reader: ordinary host filesystem reads, never a write and
* never a throw. A half-written project is a normal state during a pipeline
* run, so an unreadable path answers "unknown" instead of failing the call.
*/
const HOST_READER = {
	readText(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return;
		}
	},
	listDirectoryNames(path) {
		try {
			return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch {
			return [];
		}
	}
};
/**
* Reject a `workshopDir` that is not exactly one relative directory name.
* A separator, an absolute path, or a dot segment would let configuration move
* the gate's idea of the workshop outside the workspace it is meant to judge.
* @param value - the configured directory name.
* @returns the validated name.
*/
function validatedWorkshopDir(value) {
	const trimmed = value.trim();
	if (trimmed.length === 0 || isAbsolute(trimmed) || /[\\/]/.test(trimmed) || trimmed === "." || trimmed === "..") throw new Error(`drama-gate: workshopDir must be one relative directory name, got ${JSON.stringify(value)}`);
	return trimmed;
}
/**
* Reject a configured root that is not absolute.
* @param label - the config field name used in the failure message.
* @param value - the configured path, possibly empty.
* @returns the trimmed absolute path, or an empty string when unconfigured.
*/
function validatedRoot(label, value) {
	const trimmed = value.trim();
	if (trimmed.length > 0 && !isAbsolute(trimmed)) throw new Error(`drama-gate: ${label} must be an absolute path, got ${JSON.stringify(value)}`);
	return trimmed;
}
/**
* Install the gate's pre-execute interceptor.
* @param ctx - plugin context; the listener is scoped to it and disposed with it.
* @param config - validated {@link Config}; the path fields are re-checked fail-loud here.
*/
function apply(ctx, config) {
	const workshopDir = validatedWorkshopDir(config.workshopDir);
	const configuredRoot = validatedRoot("workspaceRoot", config.workspaceRoot);
	const projectRoot = validatedRoot("projectRoot", config.projectRoot);
	const switches = {
		idempotencyKey: config.idempotencyKey,
		shotScript: config.shotScript,
		officialAssets: config.officialAssets,
		reconcileFirst: config.reconcileFirst,
		museToolNames: config.museToolNames
	};
	ctx.on("tools/pre-execute", async (exec, next) => {
		const decision = evaluateCall({
			toolName: exec.name,
			arguments: exec.arguments,
			reader: HOST_READER,
			switches,
			sessionCwd: exec.agent?.session.header.cwd,
			configuredRoot,
			workshopDir,
			projectRoot,
			registered: ctx.tools.get(exec.name, exec.agent) !== void 0
		});
		if (decision.kind === "deny") return {
			kind: "deny",
			reason: decision.reason
		};
		return await next();
	});
}
//#endregion
export { Config, apply, checkMatchedJsonText, checkShotScriptText, countEffectiveChars, evaluateCall, inject, name, requiredSeconds };
