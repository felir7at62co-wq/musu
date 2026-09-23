import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
//#region lib/types/assets.js
/**
* Asset-manifest reading and the shot-to-asset binding rules.
*
* Binding follows the compiler's substring semantics: a shot binds every
* manifest character whose name appears in its `出镜人物` field or in its prompt
* text, every prop named by `关键道具` (falling back to the prompt text), and the
* scene named by `核心场景` (falling back to the first manifest scene named in
* the prompt text). Every bound asset must be official and must carry a Jubian
* parent asset id, a Jubian material id, and a URL — a shot that would submit
* work for an unconfirmed asset fails instead of compiling.
*
* @module @deepseek-ai/dsh-tool-shot-script/assets
*/
/** Manifest types that bind as an on-screen character. */
const CHARACTER_TYPES = new Set(["角色", "character"]);
/** Manifest types that bind as a scene. */
const SCENE_TYPES = new Set(["场景", "scene"]);
/** Manifest types that bind as a prop. */
const PROP_TYPES = new Set(["道具", "prop"]);
/** The `关键道具` placeholder that means "this shot binds no prop". */
const NO_PROPS = new Set(["", "无"]);
/** Read one manifest field as a trimmed string, or an empty string when absent. */
function text(value) {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}
/**
* Read the asset array of one project's `assets_manifest.json`.
*
* The manifest is a wire boundary: its document, its `assets` array, and every
* row's declared name and type are validated here, because a malformed manifest
* must fail loud instead of silently binding nothing.
* @param document - Parsed manifest contents.
* @param source - Manifest path, named in every failure.
* @returns The declared assets in manifest order.
* @throws {Error} When the document, its `assets` array, or a row is malformed.
*/
function parseAssetManifest(document, source) {
	if (typeof document !== "object" || document === null || Array.isArray(document)) throw new Error(`${source}: 资产清单必须是 JSON 对象，顶层键 assets 是资产数组`);
	const rows = document.assets;
	if (!Array.isArray(rows)) throw new Error(`${source}: 资产清单缺少 assets 数组`);
	return rows.map((row, index) => {
		if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error(`${source}: assets[${index}] 不是对象`);
		const record = row;
		const name = text(record.name);
		const type = text(record.type);
		if (name === "") throw new Error(`${source}: assets[${index}] 缺少 name`);
		if (type === "") throw new Error(`${source}: assets[${index}]（${name}）缺少 type`);
		return {
			name,
			id: text(record.id) || name,
			type,
			official: record.official === true,
			assetId: text(record.jubian_asset_id) || text(record.asset_id),
			materialId: text(record.jubian_material_id) || text(record.material_id),
			url: text(record.url) || text(record.image_url),
			localPath: text(record.image_path)
		};
	});
}
/** Whether one manifest row matches one of the declared type spellings. */
function isType(asset, types) {
	return types.has(asset.type);
}
/** Build one binding issue. */
function bindingIssue(severity, code, shot, message) {
	return {
		severity,
		code,
		shot: shot.shot,
		line: shot.line,
		message
	};
}
/**
* Bind one parsed shot to the manifest's official assets.
*
* The scene has one extra rule: `核心场景` must name a registered asset, because a
* scene name is free text a model can invent, while characters and props are
* matched against the manifest and therefore always resolve.
* @param shot - One parsed shot.
* @param assets - Every declared asset, in manifest order.
* @returns The shot's bound assets, its resolved scene, and every issue found.
*/
function bindShot(shot, assets) {
	const issues = [];
	const byName = /* @__PURE__ */ new Map();
	for (const asset of assets) byName.set(asset.name, asset);
	const characters = assets.filter((asset) => isType(asset, CHARACTER_TYPES) && (shot.charactersField.includes(asset.name) || shot.visual.includes(asset.name)));
	const fromField = NO_PROPS.has(shot.propsField) ? [] : assets.filter((asset) => isType(asset, PROP_TYPES) && shot.propsField.includes(asset.name));
	const props = fromField.length > 0 ? fromField : assets.filter((asset) => isType(asset, PROP_TYPES) && shot.visual.includes(asset.name));
	let scene = shot.sceneField;
	if (scene === "") scene = assets.find((asset) => isType(asset, SCENE_TYPES) && shot.visual.includes(asset.name))?.name ?? "";
	if (scene !== "" && !byName.has(scene)) issues.push(bindingIssue("failure", "unregistered_scene", shot, `镜头${shot.shot}的 核心场景：${scene} 未登记在资产清单：先把它提取成正式场景资产并确认出演，或改写成本集已登记的正式场景名。`));
	if (scene === "") issues.push(bindingIssue("warning", "no_scene_bound", shot, `镜头${shot.shot}没有绑定任何场景资产（核心场景 空缺，画面文字里也没有已登记的场景名）：成片会缺少场景一致性锚点，补一行 核心场景：<正式场景名> 更安全。`));
	const names = [...new Set([
		...characters.map((asset) => asset.name),
		...scene === "" ? [] : [scene],
		...props.map((asset) => asset.name)
	])];
	const bound = [];
	for (const name of names) {
		const asset = byName.get(name);
		if (asset === void 0) continue;
		bound.push(asset);
		if (!asset.official) {
			issues.push(bindingIssue("failure", "unconfirmed_asset", shot, `镜头${shot.shot}引用未确认出演资产：${asset.name}（official 不是 true）。先确认出演，或换成本集已登记的正式资产。`));
			continue;
		}
		const missing = [
			...asset.assetId === "" ? ["jubian_asset_id"] : [],
			...asset.materialId === "" ? ["jubian_material_id"] : [],
			...asset.url === "" ? ["URL"] : []
		];
		if (missing.length > 0) issues.push(bindingIssue("failure", "incomplete_asset", shot, `镜头${shot.shot}的资产 ${asset.name} 缺少剧变绑定信息：${missing.join("、")}。只绑定 official=true 且有剧变 asset/material ID 与 URL 的资产。`));
	}
	return {
		assets: bound.map((asset) => ({
			name: asset.name,
			id: asset.id,
			type: asset.type,
			official: asset.official,
			assetId: asset.assetId,
			materialId: asset.materialId,
			url: asset.url,
			localPath: asset.localPath
		})),
		characters: [...new Set(characters.map((asset) => asset.name))],
		scene,
		props: [...new Set(props.map((asset) => asset.name))],
		issues
	};
}
//#endregion
//#region lib/types/delivery.js
/**
* The delivery requirements one project declares for itself.
*
* The pipeline's rule tiers are separate on purpose: this tool's structural
* failures hold in every project, its built-in pacing numbers are advice, and a
* *project's* own requirements are neither. A project states those in the
* `project_config.json` that already marks its root, so the tool that compiles
* the episode reads the ceiling the project chose instead of relying on prose.
*
* @module @deepseek-ai/dsh-tool-shot-script/src/delivery
*/
/** The file whose presence marks a project root. */
const PROJECT_CONFIG = "project_config.json";
/** How many parent directories a script may sit below its project root. */
const MAX_HOPS = 4;
/**
* Read the delivery requirements of the project a script belongs to.
*
* An explicit `project` wins; otherwise the search walks up from the script's own
* directory to the nearest `project_config.json`, which is how the pipeline's own
* scripts locate a project root. No config and no declared ceiling both mean the
* project states no requirement, and the caller keeps its own number as advice. A
* ceiling that is present but unusable is an error rather than a silently
* ignored requirement.
* @param scriptPath - Absolute path of the shot script being judged.
* @param project - Absolute project root, when the call already names one.
* @returns The declared ceiling, or undefined when the project declares none.
* @throws {Error} When the ceiling is declared but is not a positive integer.
*/
async function readProjectDelivery(scriptPath, project) {
	const found = await projectConfig(scriptPath, project);
	if (found === void 0) return void 0;
	const declared = record(record(found.document)?.["delivery"])?.["max_effective_chars_per_shot"];
	if (declared === void 0) return void 0;
	if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 1) throw new Error(`${found.path} 的 delivery.max_effective_chars_per_shot 必须是正整数（每镜有效字上限），收到 ${JSON.stringify(declared)}。`);
	return {
		maxEffectiveChars: declared,
		declaredIn: found.path
	};
}
/** The project config an explicit `project` names, else the nearest one at or above the script. */
async function projectConfig(scriptPath, project) {
	if (project !== void 0) {
		const path = join(resolve(project), PROJECT_CONFIG);
		return await readConfig(path) ?? {
			path,
			document: void 0
		};
	}
	let directory = dirname(resolve(scriptPath));
	for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
		const found = await readConfig(join(directory, PROJECT_CONFIG));
		if (found !== void 0) return found;
		const parent = dirname(directory);
		if (parent === directory) return void 0;
		directory = parent;
	}
}
/** Read and parse one candidate config, or undefined when no file is there. */
async function readConfig(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return;
	}
	try {
		return {
			path,
			document: JSON.parse(text)
		};
	} catch {
		return {
			path,
			document: void 0
		};
	}
}
/** Narrow one parsed JSON value to a string-keyed record. */
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** The hold instruction the submitted prompt carries; it adds no dialogue. */
const HOLD_INSTRUCTION = "结尾保持自然反应、呼吸或动作收束，不新增台词";
/** The `@[name](key)` placeholder the prompt binds material keys with. */
const MATERIAL_PLACEHOLDER = /@\[([^\]]+)\]\(([^()\s]+)\)/g;
/** A remote asset reference, which the episode package does not copy. */
const REMOTE_REFERENCE = /^https?:\/\//i;
/**
* Read the material key of one successful placeholder match.
* @param match - A successful match of {@link MATERIAL_PLACEHOLDER}.
* @returns The captured key.
*/
function placeholderKey(match) {
	/* v8 ignore next -- the placeholder pattern always captures the key it matches. */
	return match[2] ?? "";
}
/**
* Read one prompt's ordered material keys.
*
* `select_assets` must receive the keys in exactly this order, so the order is
* the contract: first appearance in the concatenated shot prompts, duplicates
* dropped after their first position.
* @param prompt - One package's prompt text, its shots joined in script order.
* @returns Distinct placeholder keys in first-appearance order.
*/
function materialKeys(prompt) {
	const keys = /* @__PURE__ */ new Set();
	for (const match of prompt.matchAll(MATERIAL_PLACEHOLDER)) keys.add(placeholderKey(match));
	return [...keys];
}
/**
* Split shots at the boundaries one package may never cross.
*
* A package closes before a shot of another scene and after a shot marked
* `子任务边界：是`. A shot whose scene is not bound carries an empty name, which is a
* missing declaration rather than a scene of its own: it stays in the run it
* arrived in and never closes one. Reading it as a scene split an episode whose
* script declares a scene on every other shot into one package per shot; the
* missing binding itself is reported as `no_scene_bound` where the script was
* compiled.
* @param shots - Compiled shots in script order.
* @param maxContentSeconds - Content-second ceiling of one package.
* @returns Runs of shots, each packable on its own.
*/
function splitContinuityUnits(shots, maxContentSeconds) {
	const units = [];
	let current = [];
	let scene;
	for (const item of shots) {
		const duration = item.shot.durationSeconds;
		if (duration > maxContentSeconds) throw new Error(`镜头${item.shot.shot}时长${duration}秒超过内容预算${maxContentSeconds}秒；不能截断镜头。`);
		const declared = item.scene === "" ? void 0 : item.scene;
		const changedScene = declared !== void 0 && scene !== void 0 && declared !== scene;
		if (current.length > 0 && changedScene) {
			units.push(current);
			current = [];
			scene = void 0;
		}
		if (scene === void 0) scene = declared;
		current.push(item);
		if (item.shot.breakAfter) {
			units.push(current);
			current = [];
			scene = void 0;
		}
	}
	if (current.length > 0) units.push(current);
	return units;
}
/**
* Cut one run into the fewest packages that each fit the ceiling, as evenly as the
* shots allow.
*
* A greedy fill leaves a short tail (14+14+6), and a tail below the provider floor
* is an illegal request. Balancing keeps the package count identical while removing
* that tail; cuts stay between whole shots.
* @param unit - One run of continuous shots.
* @param ceiling - Content-second ceiling of one package.
* @returns Consecutive packs covering the run in order.
*/
function splitUnitEvenly(unit, ceiling) {
	const secondsOf = (shots) => shots.reduce((sum, item) => sum + item.shot.durationSeconds, 0);
	const total = secondsOf(unit);
	const count = Math.max(1, Math.ceil(total / ceiling));
	const fair = total / count;
	/** Best split of one suffix into `packs` packages; `undefined` when impossible. */
	const solve = (packs, shots) => {
		let winner;
		if (packs === 1) {
			const only = secondsOf(shots);
			if (only <= ceiling) winner = {
				packs: [shots],
				cost: (only - fair) ** 2
			};
		} else {
			let run = 0;
			for (const [index, item] of shots.entries()) {
				run += item.shot.durationSeconds;
				if (run > ceiling) break;
				const rest = solve(packs - 1, shots.slice(index + 1));
				if (rest === void 0) continue;
				const cost = (run - fair) ** 2 + rest.cost;
				if (winner === void 0 || cost < winner.cost) winner = {
					packs: [shots.slice(0, index + 1), ...rest.packs],
					cost
				};
			}
		}
		return winner;
	};
	/* v8 ignore next -- `count` is `ceil(total/ceiling)`, which always admits a split. */
	return solve(count, unit)?.packs ?? [unit];
}
/**
* Pack an episode's shots into the packages one submission each renders.
*
* A package holds a run of complete, continuous shots of one scene, never exceeds
* the content budget, and is split as evenly as the run allows. A package below
* {@link MIN_CONTENT_SECONDS} is still returned, and the caller reports it as a
* hint: refusing the run would block a legal edit the operator may still want.
* @param shots - Compiled shots in script order.
* @param maxContentSeconds - Content-second ceiling of one package.
* @returns Packages in submission order.
*/
function packEpisode(shots, maxContentSeconds) {
	const tasks = [];
	for (const unit of splitContinuityUnits(shots, maxContentSeconds)) for (const pack of splitUnitEvenly(unit, maxContentSeconds)) {
		const contentSeconds = pack.reduce((sum, item) => sum + item.shot.durationSeconds, 0);
		tasks.push({
			index: tasks.length + 1,
			shots: pack.map((item) => item.shot.shot),
			contentSeconds,
			submitSeconds: contentSeconds + 1,
			materialKeys: materialKeys(pack.map((item) => item.shot.visual).join("\n")),
			materialNames: [...new Set(pack.flatMap((item) => item.assets.map((asset) => asset.name)))]
		});
	}
	return tasks;
}
/** One bound asset as the matched JSON records it. */
function matchedAsset(asset) {
	return {
		id: asset.id,
		name: asset.name,
		type: asset.type,
		image_path: asset.localPath === "" ? asset.url : asset.localPath,
		jubian_asset_id: asset.assetId,
		jubian_material_id: asset.materialId,
		official: asset.official
	};
}
/** One compiled shot as the matched JSON records it. */
function matchedShot(item, index) {
	return {
		shot: item.shot.shot,
		segment: index + 1,
		production_mode: "live_action",
		start: item.start,
		end: item.end,
		duration: item.end - item.start,
		script_duration: item.shot.durationSeconds,
		voice_type: item.shot.voiceType,
		speaker: item.shot.speaker,
		text: item.shot.text,
		characters: item.characters,
		task_break_after: item.shot.breakAfter,
		scene: item.scene,
		props: item.props,
		visual: item.shot.visual,
		director_format: item.shot.directorFormat,
		assets: item.assets.map(matchedAsset)
	};
}
/**
* Build the matched JSON one episode compiles to.
* @param input - Episode identity, prompt path, compiled shots, and packages.
* @returns The payload written to `matches/<episode>.matched.json`.
*/
function buildMatchedPayload(input) {
	return {
		version: 4,
		episode: input.episode,
		production_mode: "live_action",
		prompt_file: input.promptFile,
		timeline_file: null,
		timing_source: "integer_shot_script",
		shots: input.shots.map(matchedShot),
		video_tasks: input.tasks.map((task) => ({
			shots: task.shots,
			content_duration: task.contentSeconds,
			natural_hold_duration: 1,
			requested_duration: task.submitSeconds,
			hold_instruction: HOLD_INSTRUCTION
		}))
	};
}
/**
* Write one episode package.
*
* Every input is checked before the first byte is written — the episode text and
* each local asset image must exist — so a refused compile leaves the project
* exactly as it was. A remote asset reference (an `http`/`https` URL) is recorded
* in the matched JSON and not copied.
* @param input - Project root, episode number, paths, payload, and shots.
* @returns Absolute paths this call created or overwrote, in write order.
* @throws {Error} When the episode text or a local asset image is missing.
*/
async function writeEpisode(input) {
	const packageDir = join(input.project, "episode_packages", input.episode);
	const packageAssets = join(packageDir, "assets");
	const episodeText = join(input.project, "episodes", `${input.episode}.txt`);
	try {
		await access(episodeText);
	} catch (error) {
		throw new Error(`${episodeText}: 项目缺少分集正文。先把剧本拆成本集正文，再编译单集 package。`, { cause: error });
	}
	const copies = [];
	const copied = /* @__PURE__ */ new Set();
	for (const item of input.shots) for (const asset of item.assets) {
		if (asset.localPath === "" || REMOTE_REFERENCE.test(asset.localPath) || copied.has(asset.id)) continue;
		copied.add(asset.id);
		const source = isAbsolute(asset.localPath) ? asset.localPath : resolve(input.project, asset.localPath);
		try {
			await access(source);
		} catch (error) {
			throw new Error(`${source}: 资产「${asset.name}」的本地图片不存在。修正 assets_manifest.json 的 image_path，或重新生成该资产，再编译。`, { cause: error });
		}
		copies.push({
			source,
			target: join(packageAssets, asset.type, basename(source))
		});
	}
	const json = JSON.stringify(input.payload, null, 2);
	const written = [];
	await mkdir(dirname(input.promptPath), { recursive: true });
	await mkdir(dirname(input.matchedPath), { recursive: true });
	await mkdir(packageAssets, { recursive: true });
	if (resolve(input.scriptPath) !== resolve(input.promptPath)) {
		await copyFile(input.scriptPath, input.promptPath);
		written.push(input.promptPath);
	}
	await writeFile(input.matchedPath, json, "utf8");
	written.push(input.matchedPath);
	const packageJson = join(packageDir, "package.json");
	await writeFile(packageJson, json, "utf8");
	written.push(packageJson);
	for (const copy of [
		{
			source: input.promptPath,
			target: join(packageDir, "shot_script.txt")
		},
		{
			source: input.matchedPath,
			target: join(packageDir, "matched.json")
		},
		{
			source: episodeText,
			target: join(packageDir, "episode.txt")
		},
		...copies
	]) {
		await mkdir(dirname(copy.target), { recursive: true });
		await copyFile(copy.source, copy.target);
		written.push(copy.target);
	}
	return written;
}
//#endregion
//#region lib/types/report.js
/**
* Builders from the compiler's internal shapes to the model-facing result.
*
* The result keeps the pipeline's own snake_case spellings, because it is read
* next to `content_duration_ms`, `assets_manifest.json`, and the Jubian tool
* arguments it feeds.
*
* @module @deepseek-ai/dsh-tool-shot-script/report
*/
/** One issue as the model reads it. */
function issueReport(issue) {
	return {
		severity: issue.severity,
		code: issue.code,
		line: issue.line,
		shot: issue.shot,
		message: issue.message
	};
}
/** One shot's derived facts as the model reads them. */
function shotReport(item) {
	return {
		shot: item.shot.shot,
		line: item.shot.line,
		voice_type: item.shot.voiceType,
		speaker: item.shot.speaker,
		text: item.shot.text,
		effective_chars: item.shot.effectiveChars,
		duration_seconds: item.shot.durationSeconds,
		duration_source: item.shot.durationSource,
		offscreen: item.shot.offscreen,
		characters_field: item.shot.charactersField,
		scene: item.scene,
		props_field: item.shot.propsField,
		bindings: item.assets.map((asset) => ({
			name: asset.name,
			type: asset.type,
			official: asset.official,
			asset_id: asset.assetId,
			material_id: asset.materialId,
			url: asset.url
		}))
	};
}
/** One packaging plan as the model reads it. */
function packageReport(task) {
	return {
		index: task.index,
		shots: task.shots,
		content_seconds: task.contentSeconds,
		content_duration_ms: task.contentSeconds * 1e3,
		submit_seconds: task.submitSeconds,
		natural_hold_seconds: 1,
		hold_instruction: HOLD_INSTRUCTION,
		material_keys: task.materialKeys,
		material_names: task.materialNames
	};
}
/**
* Build the canonical result of one `drama_shot` call.
*
* `ok` is true exactly when no failure-severity issue was found; warnings ride
* along without changing it.
* @param input - Operation identity, compiled shots, issues, packages, and written paths.
* @returns The result the tool returns and renders.
*/
function buildReport(input) {
	const failures = input.issues.filter((issue) => issue.severity === "failure").map(issueReport);
	const warnings = input.issues.filter((issue) => issue.severity === "warning").map(issueReport);
	return {
		method: input.method,
		ok: failures.length === 0,
		script: input.script,
		assets_manifest: input.assetsManifest,
		assets_checked: input.assetsChecked,
		shots: input.shots.map(shotReport),
		packages: input.tasks.map(packageReport),
		failures,
		warnings,
		written: [...input.written],
		summary: {
			shots: input.shots.length,
			packages: input.tasks.length,
			content_seconds: input.tasks.reduce((total, task) => total + task.contentSeconds, 0),
			failures: failures.length,
			warnings: warnings.length
		}
	};
}
//#endregion
//#region lib/types/script.js
/**
* Director-format shot-script parsing and this format's decidable rules.
*
* Each `【镜头N】` block preserves its speech and voice choice. Explicit positive
* whole-second durations take precedence over speech/complexity estimates.
* Creative checks produce warnings; malformed fields remain failures.
*
* The parser never throws and never stops at the first problem: it returns every
* parsed shot plus the complete issue list, so one call tells the model
* everything it must repair.
*
* @module @deepseek-ai/dsh-tool-shot-script/script
*/
/** Han characters, Latin letters, and digits: punctuation and spaces never count. */
const EFFECTIVE_CHARS = /[\u4e00-\u9fffA-Za-z0-9]/g;
/**
* Narration declarations produce advisory guidance and retain speech as `vo`.
* Ordinary dialogue containing these words is not scanned.
*/
const NARRATION_MARKERS = /(旁白|解说|心声|画外声|叙述|\bos\b)/i;
/** `（画外音）`/`(VO)` on a speaker name: the sentence continues off screen. */
const OFFSCREEN_SUFFIX = /[（(]\s*(?:画外音|vo)\s*[）)]\s*$/i;
/** A bare `画外音`/`vo` label in the speech-label or voice-type position. */
const OFFSCREEN_LABEL = /^(?:画外音|vo)$/i;
/** One speech line: a label, a colon, and a payload that may be empty. */
const SPEECH_LINE = /^(台词|画外音|画外声|心声|旁白|解说|VO|OS|dialogue)[：:][ \t]*(.*)$/gim;
/** `台词：角色名：原文` — the speaker prefix the director format allows. */
const SPEAKER_PREFIX = /^([^：:]{1,30})[：:](.+)$/;
/** `台词：角色名：` — a speaker prefix with nothing left to say. */
const SPEAKER_PREFIX_ONLY = /^([^：:]{1,30})[：:]\s*$/;
/** The style line every shot block is preceded by, with the whitespace that follows it. */
const STYLE_LINE = /真人短剧写实风格\s*$/;
/** A suggested negative prompt; absence only produces a warning. */
const NEGATIVE_PROMPT = "无噪点，无跳帧，五官稳定不变形";
/** A marker line, captured together with its shot number. */
const SHOT_MARKER = /^【镜头(\d+)】[ \t]*$/gm;
/** The legacy `时长` field, tolerated on old scripts and stripped from the prompt. */
const LEGACY_DURATION = /^时长[：:][ \t]*(.*)$/m;
/** A legacy duration value this format still accepts on an old script. */
const LEGACY_DURATION_VALUE = /^[1-9]\d*秒$/;
/** Any seconds expression left in a shot body. */
const SECONDS_IN_BODY = /\d[ \t]*秒/;
/** The `出镜人物` placeholder this format refuses, with optional sentence punctuation. */
const CHARACTERS_PLACEHOLDER = /^无[。.！!？?\s]*$/;
/** Per-shot complexity labels and the whole seconds each charges to a package. */
const ACTION_COMPLEXITY = {
	"简单": 1,
	"一般": 2,
	"较复杂": 3,
	"复杂": 4
};
/** Every accepted `动作复杂度` label, for the refusal message. */
const COMPLEXITY_LABELS = "简单/一般/较复杂/复杂";
/** The writing threshold above which the source sentence should have been split. */
const WRITING_THRESHOLD_CHARS = 15;
/** Guidance for checking the project's voice choice without rewriting speech. */
const NARRATION_FIX_HINT = "将作为 vo 画外发声保留，不阻塞编译；请核对本项目是否需要旁白/心声，并核对说话人、原文与后期发声轨，不要删改原文。";
/**
* Count the effective characters of one spoken text: Han characters, Latin
* letters, and digits. Punctuation, spaces, and symbols do not count, so reading
* speed is measured the way this format's 9 字/秒 rule measures it.
* @param text - Spoken text, with or without punctuation.
* @returns The number of effective characters.
*/
function effectiveChars(text) {
	return (text.match(EFFECTIVE_CHARS) ?? []).length;
}
/**
* Derive a speaking shot's whole-second duration.
* @param chars - Effective characters of the spoken text.
* @returns `max(1, ceil(chars / 9))` seconds.
*/
function speechSeconds(chars) {
	return Math.max(1, Math.ceil(chars / 9));
}
/** Trim the bracket forms the older gate shell wrapped field values in. */
function trimBrackets(value) {
	return value.trim().replace(/^[【】]+/, "").replace(/[【】]+$/, "");
}
/**
* Read one capture group of a successful match.
* @param match - A successful match of a pattern this module owns.
* @param index - 1-based capture-group index.
* @returns The captured text.
*/
function capture(match, index) {
	/* v8 ignore next -- every pattern read through this helper requires the group it returns. */
	return match[index] ?? "";
}
/**
* Read one field, or an empty string when the block omits it.
*
* Two spellings are accepted for every field: the canonical `名称：值`, and the
* older gate shell's `名称【值】`, which wrapped values in brackets.
*/
function field(block, name) {
	const bracketed = new RegExp(`^${name}【(.+)】[ \\t]*$`, "m").exec(block);
	if (bracketed !== null) return capture(bracketed, 1).trim();
	const colon = new RegExp(`^${name}[：:][ \\t]*(.+)$`, "m").exec(block);
	return colon === null ? "" : trimBrackets(capture(colon, 1));
}
/** The 1-based line holding one character offset. */
function lineAt(text, offset) {
	let line = 1;
	for (let index = text.indexOf("\n"); index >= 0 && index < offset; index = text.indexOf("\n", index + 1)) line += 1;
	return line;
}
/** Build one issue. */
function issue(severity, code, shot, line, message) {
	return {
		severity,
		code,
		shot,
		line,
		message
	};
}
/** Locate every `【镜头N】` block with the offsets its line numbers and text need. */
function splitBlocks(text) {
	const blocks = [];
	const markers = [...text.matchAll(SHOT_MARKER)];
	for (const [index, marker] of markers.entries()) blocks.push({
		start: marker.index,
		end: markers[index + 1]?.index ?? text.length,
		number: Number(capture(marker, 1))
	});
	return blocks;
}
/** Read the voice-type declaration, preferring `发声类型` over the older `语音类型`. */
function readVoiceType(text, block, blockText) {
	const declared = field(blockText, "发声类型");
	const name = declared === "" ? "语音类型" : "发声类型";
	const value = declared === "" ? field(blockText, "语音类型") : declared;
	if (value === "") return {
		value,
		line: lineAt(text, block.start),
		issues: []
	};
	const line = lineAt(text, block.start + fieldOffset(blockText, name));
	const marker = NARRATION_MARKERS.exec(value);
	if (marker === null) return {
		value,
		line,
		issues: []
	};
	return {
		value,
		line,
		issues: [issue("warning", "narration_marker", block.number, line, `镜头${block.number}（脚本第${line}行）出现旁白/心声标记「${marker[0]}」：${NARRATION_FIX_HINT}`)]
	};
}
/** Read the silence or speech declaration of one shot block. */
function readSpeech(text, block, blockText, directorFormat) {
	const voice = readVoiceType(text, block, blockText);
	const issues = [...voice.issues];
	const markerLine = lineAt(text, block.start);
	const declaredAction = voice.value.trim().toLowerCase() === "action";
	const speechLines = [...blockText.matchAll(SPEECH_LINE)];
	for (const line of speechLines) {
		const marker = NARRATION_MARKERS.exec(capture(line, 1));
		if (marker === null) continue;
		const at = lineAt(text, block.start + line.index);
		issues.push(issue("warning", "narration_marker", block.number, at, `镜头${block.number}（脚本第${at}行）出现旁白/心声标记「${marker[0]}」：${NARRATION_FIX_HINT}`));
	}
	const first = speechLines[0];
	if (first === void 0) {
		if (!declaredAction) issues.push(issue("failure", "missing_voice_type", block.number, markerLine, `镜头${block.number}无正式发声时必须标记 发声类型：action。`));
		return {
			voiceType: "action",
			speaker: "",
			text: "",
			line: markerLine,
			issues
		};
	}
	const line = lineAt(text, block.start + first.index);
	if (speechLines.length > 1) issues.push(issue("failure", "multiple_speech_lines", block.number, line, `镜头${block.number}最多只能有一条正式发声原文，实际 ${speechLines.length} 条：同一句话被切镜时不拆成两条，后半句写成 台词：角色名（画外音）：原文台词。`));
	if (declaredAction) issues.push(issue("failure", "action_voice_with_dialogue", block.number, line, `镜头${block.number}同时声明了 发声类型：action 与台词行：二者只能留一个——有台词就删掉 action 行（时长按字数推导），无台词就删掉台词行。`));
	let offscreen = OFFSCREEN_LABEL.test(voice.value.trim()) || NARRATION_MARKERS.test(voice.value) || OFFSCREEN_LABEL.test(capture(first, 1)) || NARRATION_MARKERS.test(capture(first, 1));
	let speaker = field(blockText, "说话人");
	let spoken = capture(first, 2).trim();
	if (directorFormat && !NARRATION_MARKERS.test(capture(first, 1))) {
		const prefix = SPEAKER_PREFIX.exec(spoken);
		if (prefix !== null) {
			const possibleSpeaker = capture(prefix, 1).trim();
			const marker = NARRATION_MARKERS.exec(possibleSpeaker);
			if (marker !== null) issues.push(issue("warning", "narration_marker", block.number, line, `镜头${block.number}（脚本第${line}行）出现旁白/心声标记「${marker[0]}」：${NARRATION_FIX_HINT}`));
			offscreen = offscreen || marker !== null || OFFSCREEN_SUFFIX.test(possibleSpeaker);
			speaker = possibleSpeaker.replace(OFFSCREEN_SUFFIX, "").trim();
			spoken = capture(prefix, 2).trim();
		} else if (SPEAKER_PREFIX_ONLY.test(spoken)) spoken = "";
		if (OFFSCREEN_LABEL.test(capture(first, 1).trim())) offscreen = true;
	}
	if (spoken === "" || effectiveChars(spoken) === 0) issues.push(issue("failure", "empty_dialogue_line", block.number, line, `镜头${block.number}（脚本第${line}行）的台词没有任何有效字（汉字/字母/数字）：它会编译出一条空字幕。无声镜只写 发声类型：action，并整行省略台词行；有台词的镜头请写出实际原文。`));
	else if (CHARACTERS_PLACEHOLDER.test(spoken)) issues.push(issue("failure", "placeholder_dialogue", block.number, line, `镜头${block.number}（脚本第${line}行）的台词是「${spoken}」：它会编译出一条「无」的假字幕；无声镜只写 发声类型：action，并整行省略台词行。`));
	return {
		voiceType: offscreen ? "vo" : "dialogue",
		speaker,
		text: spoken,
		line,
		issues
	};
}
/** The offset of one field's declaring line inside the block. */
function fieldOffset(blockText, name) {
	return new RegExp(`^${name}[：:]`, "m").exec(blockText)?.index ?? 0;
}
/** Read one shot's duration from its speech, its complexity label, or the default. */
function readDuration(text, block, blockText, speech, options) {
	const issues = [];
	const complexity = field(blockText, "动作复杂度");
	const complexityLine = lineAt(text, block.start + fieldOffset(blockText, "动作复杂度"));
	if (speech.text === "") {
		if (complexity === "") return {
			seconds: options.actionShotSeconds,
			source: "default",
			issues
		};
		const seconds = ACTION_COMPLEXITY[complexity];
		if (seconds === void 0) {
			issues.push(issue("failure", "unknown_action_complexity", block.number, complexityLine, `镜头${block.number}的 动作复杂度：${complexity} 不是合法取值：只接受 ${COMPLEXITY_LABELS}（分别按 1/2/3/4 秒计入打包预算）；复杂动作取 3–4 秒，普通反应与简单动作 1–2 秒。`));
			return {
				seconds: options.actionShotSeconds,
				source: "default",
				issues
			};
		}
		return {
			seconds,
			source: "complexity",
			issues
		};
	}
	if (complexity !== "") issues.push(issue("warning", "action_complexity_on_speaking_shot", block.number, complexityLine, `镜头${block.number}同时有台词与动作复杂度：估算以发声为准，明确时长声明优先；请核对说话时的动作与停顿是否需要额外时间，不必删除动作描述。`));
	const chars = effectiveChars(speech.text);
	const seconds = speechSeconds(chars);
	const declared = options.maxEffectiveChars;
	const limit = declared ?? 36;
	if (chars > limit) issues.push(declared === void 0 ? issue("warning", "speech_too_long", block.number, speech.line, `镜头${block.number}语音${chars}字，超过建议的 ${limit} 字（估算 ${seconds} 秒）：请核对节奏与实际发声时长；可保留长镜头，或按原文语义拆镜，不删改原文与说话人。`) : issue("failure", "speech_exceeds_project_limit", block.number, speech.line, `镜头${block.number}语音${chars}字，超过本项目 project_config.json 声明的每镜上限 ${limit} 字（估算 ${seconds} 秒）：按原文语义拆成连续镜头，不删字、不改顺序、不换说话人；若本项目实际不适用这条要求，改掉或删掉 project_config.json 的 delivery.max_effective_chars_per_shot 再编译。`));
	else if (chars > WRITING_THRESHOLD_CHARS) issues.push(issue("warning", "speech_above_writing_threshold", block.number, speech.line, `镜头${block.number}语音${chars}字，超过 ${WRITING_THRESHOLD_CHARS} 字的写作阈值：按 9 有效字/秒记为 ${seconds} 秒、不阻塞编译；原文语义上还能拆就拆成连续镜头（不删字、不改顺序）。`));
	return {
		seconds,
		source: "speech",
		issues
	};
}
/**
* Parse one director-format shot script into its shots and every issue it
* carries. The text is judged exactly as written: this function reads no other
* file and performs no I/O.
* @param text - Contents of the shot script, with or without a byte-order mark.
* @param options - The compiler default a silent shot without a complexity label takes.
* @returns Parsed shots in script order plus the complete issue list.
*/
function parseShotScript(text, options) {
	const issues = [];
	const shots = [];
	const blocks = splitBlocks(text);
	if (blocks.length === 0) {
		issues.push(issue("failure", "no_shots", 0, 0, "脚本里没有任何【镜头N】块：本工具编译导演格式镜头脚本，每个镜头以独占一行的【镜头N】开头，其上一行是 真人短剧写实风格。"));
		return {
			shots,
			issues
		};
	}
	for (const block of blocks) {
		const blockText = text.slice(block.start, block.end);
		const markerLine = lineAt(text, block.start);
		if (!STYLE_LINE.test(text.slice(0, block.start))) issues.push(issue("warning", "missing_style_line", block.number, markerLine, `镜头${block.number}（脚本第${markerLine}行）前没有建议的「真人短剧写实风格」行：请按项目选择风格，不会自动补入固定风格。`));
		const legacy = LEGACY_DURATION.exec(blockText);
		const legacyValue = legacy === null ? "" : capture(legacy, 1).trim();
		const legacyLine = legacy === null ? 0 : lineAt(text, block.start + legacy.index);
		const body = blockText.replace(/^时长[：:].*$\n?/gm, "");
		const declaredSeconds = legacy === null ? void 0 : Number(legacyValue.replace(/秒$/, ""));
		const validDuration = legacy !== null && LEGACY_DURATION_VALUE.test(legacyValue) && Number.isSafeInteger(declaredSeconds);
		if (legacy !== null && !validDuration) issues.push(issue("failure", "legacy_duration_invalid", block.number, legacyLine, `镜头${block.number}时长必须是正整数秒：${legacyValue}。例如「时长：20秒」；省略时长行时按台词或动作复杂度估算。`));
		const seconds = SECONDS_IN_BODY.exec(body);
		if (seconds !== null) {
			const line = lineAt(text, block.start + seconds.index);
			issues.push(issue("warning", "seconds_in_shot_body", block.number, line, `镜头${block.number}（脚本第${line}行）出现秒数「${seconds[0]}」：请区分台词原文与拍摄时间要求；正文秒数不改变打包时长，需指定预算时写独立的「时长：N秒」。`));
		}
		const directorFormat = blockText.includes("主体状态追踪：");
		if (directorFormat && !blockText.includes(NEGATIVE_PROMPT)) issues.push(issue("warning", "missing_negative_prompt", block.number, markerLine, `镜头${block.number}没有建议的负面提示「${NEGATIVE_PROMPT}」：请按项目与模型选择是否需要，不自动补入。`));
		const speech = readSpeech(text, block, blockText, directorFormat);
		issues.push(...speech.issues);
		const duration = readDuration(text, block, blockText, speech, options);
		issues.push(...duration.issues);
		if (validDuration && declaredSeconds !== duration.seconds) issues.push(issue("warning", "legacy_duration_mismatch", block.number, legacyLine, `镜头${block.number}估算为${duration.seconds}秒，采用声明的${legacyValue}。请试听确认语速、停顿与动作时间；估算不覆盖导演声明。`));
		if (validDuration && declaredSeconds !== void 0) {
			duration.seconds = declaredSeconds;
			duration.source = "declared";
		}
		const charactersField = field(blockText, "出镜人物");
		if (CHARACTERS_PLACEHOLDER.test(charactersField)) {
			const line = lineAt(text, block.start + fieldOffset(blockText, "出镜人物"));
			issues.push(issue("failure", "characters_placeholder", block.number, line, `镜头${block.number}的 出镜人物：${charactersField} 不接受占位值：零人物绑定的镜头（纯道具、纯镜像细节）整行省略 出镜人物，不要用「无」占位。`));
		}
		shots.push({
			shot: block.number,
			line: markerLine,
			voiceType: speech.voiceType,
			speaker: speech.speaker,
			text: speech.text,
			effectiveChars: effectiveChars(speech.text),
			durationSeconds: duration.seconds,
			durationSource: duration.source,
			offscreen: speech.voiceType === "vo",
			charactersField,
			sceneField: field(blockText, "核心场景"),
			propsField: field(blockText, "关键道具"),
			visual: `${STYLE_LINE.test(text.slice(0, block.start)) ? "真人短剧写实风格\n" : ""}${body.trim()}`,
			directorFormat,
			breakAfter: field(blockText, "子任务边界") === "是"
		});
	}
	const deviation = shots.find((item, index) => item.shot !== index + 1);
	if (deviation !== void 0) {
		const position = shots.indexOf(deviation) + 1;
		issues.push(issue("failure", "shot_numbering", deviation.shot, deviation.line, `镜头号不连续：第 ${position} 个镜头块的编号是「${deviation.shot}」，应为 ${position}；镜头必须从 1 开始连续编号，不跳号、不重复。`));
	}
	return {
		shots,
		issues
	};
}
//#endregion
//#region lib/types/index.js
/**
* `drama_shot`: the short-drama pipeline's shot-script gate and episode compiler,
* as one model-facing tool.
*
* The pipeline's hard rules used to live in skill prose, where a model could skip
* them. They are decidable — a rule is enforced here exactly when the script
* text, the asset manifest, and the package budget settle it — so this plugin
* judges them in the operation that produces the artifact. Creative guidance
* (how a shot should read, how a cut should feel) stays in the skills.
*
* `validate` and `preview` read only; `compile` writes the matched JSON and the
* episode package, and a script with any failure-severity issue writes nothing.
*
* @module @deepseek-ai/dsh-tool-shot-script
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "tool-shot-script";
/** The tool registry this plugin contributes `drama_shot` to. */
const inject = ["tools"];
/** Seconds a silent shot takes when it declares no `动作复杂度`; the schema default too. */
const DEFAULT_ACTION_SHOT_SECONDS = 2;
/** Validated config schema: the fallback budget must stay inside the 1–4 second shot rule. */
const Config = z.object({ actionShotSeconds: z.number().step(1).min(1).max(4).default(DEFAULT_ACTION_SHOT_SECONDS) });
/** Read one file as UTF-8 text without a byte-order mark. */
async function readText(path) {
	const text = await readFile(path, "utf8");
	return text.startsWith("﻿") ? text.slice(1) : text;
}
/**
* Narrow one call's arguments to the paths its method cannot run without.
*
* `validate` needs only the script; `preview` adds the asset manifest, because
* the scene key decides package boundaries; `compile` adds the project root and
* the episode number it writes under. A `project` given to any method is kept, so
* every method reads the project's own delivery requirements.
* @param args - The dispatched arguments.
* @returns The resolved script, manifest, project, and compile destination.
* @throws {Error} When the method's required arguments are missing or the episode number is not a positive integer.
*/
function resolveCall(args) {
	const script = resolve(args.script);
	const project = args.project === void 0 ? void 0 : resolve(args.project);
	if (args.method === "validate") return args.assets === void 0 ? {
		script,
		project
	} : {
		script,
		assets: resolve(args.assets),
		project
	};
	if (args.assets === void 0) throw new Error(`drama_shot ${args.method} 需要 assets：资产清单（assets_manifest.json）的路径，它决定资产绑定与每包的场景边界。`);
	const assets = resolve(args.assets);
	if (args.method === "preview") return {
		script,
		assets,
		project
	};
	const { episode } = args;
	if (project === void 0 || episode === void 0) throw new Error("drama_shot compile 需要 project 与 episode：project 是项目根目录（含 episodes/、prompts/、matches/、episode_packages/），episode 是集号。");
	if (episode < 1) throw new Error(`drama_shot compile 的 episode 必须是正整数集号，收到 ${episode}。`);
	const number = String(episode).padStart(2, "0");
	return {
		script,
		assets,
		project,
		target: {
			project,
			episode: number,
			promptPath: join(project, "prompts", `${number}.txt`),
			matchedPath: join(project, "matches", `${number}.matched.json`)
		}
	};
}
/** Read and validate one project's asset manifest. */
async function readManifest(path) {
	const text = await readText(path);
	let document;
	try {
		document = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path}: 资产清单不是合法 JSON。请确认它是 UTF-8 的 assets_manifest.json，顶层为 {"assets": [...]}。`, { cause: error });
	}
	return parseAssetManifest(document, path);
}
/** Bind every parsed shot and lay the episode timeline out from the derived durations. */
function compileShots(shots, manifest) {
	const compiled = [];
	const issues = [];
	let cursor = 0;
	for (const shot of shots) {
		const binding = manifest === void 0 ? void 0 : bindShot(shot, manifest);
		if (binding !== void 0) issues.push(...binding.issues);
		compiled.push({
			shot,
			characters: binding?.characters ?? [],
			scene: binding?.scene ?? "",
			props: binding?.props ?? [],
			assets: binding?.assets ?? [],
			start: cursor,
			end: cursor + shot.durationSeconds
		});
		cursor += shot.durationSeconds;
	}
	return {
		compiled,
		issues
	};
}
/**
* Write the compiled episode into its project.
* @param call - The resolved call, whose compile destination must be present.
* @param compiled - Compiled shots in script order.
* @param tasks - Packages in submission order.
* @param failed - Whether a failure-severity issue blocks the write.
* @returns Absolute paths this call created or overwrote, or none when nothing may be written.
*/
async function writeTarget(call, compiled, tasks, failed) {
	const target = call.target;
	if (failed || target === void 0) return [];
	const payload = buildMatchedPayload({
		episode: target.episode,
		promptFile: target.promptPath,
		shots: compiled,
		tasks
	});
	return await writeEpisode({
		...target,
		scriptPath: call.script,
		payload,
		shots: compiled
	});
}
/**
* Judge, and for `compile` write, one episode of the short-drama pipeline.
* @param args - The dispatched arguments.
* @param config - The resolved compiler configuration.
* @returns The canonical result; a script with failures never reaches the filesystem.
*/
async function runDramaShot(args, config) {
	const call = resolveCall(args);
	const scriptText = await readText(call.script);
	const delivery = await readProjectDelivery(call.script, call.project);
	const parsed = parseShotScript(scriptText, {
		actionShotSeconds: config.actionShotSeconds,
		maxEffectiveChars: delivery?.maxEffectiveChars
	});
	const manifest = call.assets === void 0 ? void 0 : await readManifest(call.assets);
	const { compiled, issues: bindingIssues } = compileShots(parsed.shots, manifest);
	const issues = [...parsed.issues, ...bindingIssues];
	let maxContentSeconds = 0;
	let tasks = [];
	if (args.method !== "validate") {
		const maximum = args.max_submit_seconds;
		if (maximum === void 0 || !Number.isSafeInteger(maximum) || maximum <= 1) throw new Error("preview/compile 需要 max_submit_seconds：目标分镜实际请求的整数总秒数（含收束秒），且在已确认模型能力内；不要默认取模型最大值。");
		maxContentSeconds = maximum - 1;
		for (const { shot } of compiled) if (shot.durationSeconds > maxContentSeconds) issues.push({
			severity: "failure",
			code: "shot_exceeds_package_budget",
			shot: shot.shot,
			line: shot.line,
			message: `镜头${shot.shot}为${shot.durationSeconds}秒，超过本次内容预算${maxContentSeconds}秒（提交上限${maximum}秒，含1秒收束）；请选择支持的分镜时长或按原文语义拆镜，不能截断。`
		});
		if (!issues.some((issue) => issue.severity === "failure")) {
			tasks = packEpisode(compiled, maxContentSeconds);
			for (const task of tasks) {
				if (task.contentSeconds >= 3) continue;
				const first = compiled.find((item) => item.shot.shot === task.shots[0]);
				/* v8 ignore next -- the packer numbers every package from these same shots. */
				if (first === void 0) continue;
				issues.push({
					severity: "warning",
					code: "package_below_minimum",
					shot: first.shot.shot,
					line: first.shot.line,
					message: `第${task.index}包只有${task.contentSeconds}秒内容（请求${task.submitSeconds}秒，镜头${task.shots.join("、")}），低于供应商4秒请求下限，提交会被平台拒且不计费；建议把这几镜并进同场相邻包，或按原文语义把这一场写足。`
				});
			}
		}
	}
	const failed = issues.some((issue) => issue.severity === "failure");
	if (failed) tasks = [];
	const written = args.method === "compile" ? await writeTarget(call, compiled, tasks, failed) : [];
	return buildReport({
		method: args.method,
		script: call.script,
		assetsManifest: call.assets ?? "",
		assetsChecked: manifest !== void 0,
		shots: compiled,
		issues,
		tasks,
		written
	});
}
/** The one sentence every issue-field description repeats. */
const ISSUE_SHAPE = "severity=failure 表示必须先修好再编译，warning 不阻塞编译。";
/** Model-facing result schema: every field of the canonical report, all of them always present. */
const RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		method: {
			type: "string",
			required: true,
			enum: [
				"validate",
				"preview",
				"compile"
			],
			description: "产生本结果的操作。"
		},
		ok: {
			type: "boolean",
			required: true,
			description: "是否通过全部硬失败；false 时没有写任何文件、也没有打包方案。"
		},
		script: {
			type: "string",
			required: true,
			description: "被判定镜头脚本的绝对路径。"
		},
		assets_manifest: {
			type: "string",
			required: true,
			description: "资产清单绝对路径；空串表示本次没有给清单（validate 未做资产绑定判定）。"
		},
		assets_checked: {
			type: "boolean",
			required: true,
			description: "是否判定过资产绑定。"
		},
		shots: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					shot: {
						type: "integer",
						required: true,
						description: "镜头号。"
					},
					line: {
						type: "integer",
						required: true,
						description: "【镜头N】在脚本里的行号。"
					},
					voice_type: {
						type: "string",
						required: true,
						enum: [
							"dialogue",
							"vo",
							"action"
						],
						description: "dialogue=画面内台词；vo=画外发声，含旁白/心声；action=无发声。"
					},
					speaker: {
						type: "string",
						required: true,
						description: "说话人；无声镜为空串。"
					},
					text: {
						type: "string",
						required: true,
						description: "去掉说话人前缀后的台词原文；无声镜为空串。"
					},
					effective_chars: {
						type: "integer",
						required: true,
						description: "有效字：汉字/字母/数字，标点与空格不计。"
					},
					duration_seconds: {
						type: "integer",
						required: true,
						description: "本镜计入打包预算的整秒数。"
					},
					duration_source: {
						type: "string",
						required: true,
						enum: [
							"speech",
							"declared",
							"complexity",
							"default"
						],
						description: "时长来源：明确声明、9 有效字/秒估算、动作复杂度、或编译器默认值。"
					},
					offscreen: {
						type: "boolean",
						required: true,
						description: "是否是同场画外音。"
					},
					characters_field: {
						type: "string",
						required: true,
						description: "出镜人物 字段原文；整行省略时为空串。"
					},
					scene: {
						type: "string",
						required: true,
						description: "绑定到的正式场景名；空串表示没有绑定场景。"
					},
					props_field: {
						type: "string",
						required: true,
						description: "关键道具 字段原文；整行省略时为空串。"
					},
					bindings: {
						type: "array",
						required: true,
						description: "本镜绑定的资产，顺序为 人物 → 场景 → 道具。",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: {
									type: "string",
									required: true,
									description: "资产正式名。"
								},
								type: {
									type: "string",
									required: true,
									description: "资产类型。"
								},
								official: {
									type: "boolean",
									required: true,
									description: "是否 official=true。"
								},
								asset_id: {
									type: "string",
									required: true,
									description: "剧变父资产 ID；缺失为空串。"
								},
								material_id: {
									type: "string",
									required: true,
									description: "剧变生成材质 ID；缺失为空串。"
								},
								url: {
									type: "string",
									required: true,
									description: "剧变资产 URL；缺失为空串。"
								}
							}
						}
					}
				}
			}
		},
		packages: {
			type: "array",
			required: true,
			description: "每包对应一次剧变提交；硬失败时为空数组。",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					index: {
						type: "integer",
						required: true,
						description: "包序号，从 1 开始。"
					},
					shots: {
						type: "array",
						required: true,
						items: { type: "integer" },
						description: "本包镜头号，按脚本顺序。"
					},
					content_seconds: {
						type: "integer",
						required: true,
						description: "本包内容时长（整秒），加收束不超过 max_submit_seconds。"
					},
					content_duration_ms: {
						type: "integer",
						required: true,
						description: "提交 jubian_storyboard generate 的 content_duration_ms（整千毫秒）。"
					},
					submit_seconds: {
						type: "integer",
						required: true,
						description: "提交给剧变的整秒时长：内容时长 + 1 秒自然收束。"
					},
					natural_hold_seconds: {
						type: "integer",
						required: true,
						description: "自然收束秒数，固定 1。"
					},
					hold_instruction: {
						type: "string",
						required: true,
						description: "写进提示词的收束要求，不新增台词。"
					},
					material_keys: {
						type: "array",
						required: true,
						items: { type: "string" },
						description: "本包提示词里 @[名称](key) 的 key，按出现顺序去重；select_assets 必须按这个顺序提交。"
					},
					material_names: {
						type: "array",
						required: true,
						items: { type: "string" },
						description: "本包镜头绑定的资产名，按镜头顺序去重。"
					}
				}
			}
		},
		failures: {
			type: "array",
			required: true,
			description: ISSUE_SHAPE,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					severity: {
						type: "string",
						required: true,
						enum: ["failure", "warning"],
						description: ISSUE_SHAPE
					},
					code: {
						type: "string",
						required: true,
						description: "稳定的规则代码（见包 README 的代码表）。"
					},
					line: {
						type: "integer",
						required: true,
						description: "脚本行号；0 表示整篇问题。"
					},
					shot: {
						type: "integer",
						required: true,
						description: "镜头号；0 表示整篇问题。"
					},
					message: {
						type: "string",
						required: true,
						description: "中文说明：指出违规值并给出修法。"
					}
				}
			}
		},
		warnings: {
			type: "array",
			required: true,
			description: ISSUE_SHAPE,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					severity: {
						type: "string",
						required: true,
						enum: ["failure", "warning"],
						description: ISSUE_SHAPE
					},
					code: {
						type: "string",
						required: true,
						description: "稳定的规则代码（见包 README 的代码表）。"
					},
					line: {
						type: "integer",
						required: true,
						description: "脚本行号；0 表示整篇问题。"
					},
					shot: {
						type: "integer",
						required: true,
						description: "镜头号；0 表示整篇问题。"
					},
					message: {
						type: "string",
						required: true,
						description: "中文说明：指出违规值并给出修法。"
					}
				}
			}
		},
		written: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "本次写入的绝对路径；只有 compile 通过后才非空。"
		},
		summary: {
			type: "object",
			required: true,
			additionalProperties: false,
			properties: {
				shots: {
					type: "integer",
					required: true,
					description: "镜头数。"
				},
				packages: {
					type: "integer",
					required: true,
					description: "包数。"
				},
				content_seconds: {
					type: "integer",
					required: true,
					description: "全部包的内容时长之和。"
				},
				failures: {
					type: "integer",
					required: true,
					description: "硬失败条数。"
				},
				warnings: {
					type: "integer",
					required: true,
					description: "警告条数。"
				}
			}
		}
	}
};
/** What the model reads before calling: what each method does and which rules decide the verdict. */
const DESCRIPTION = "短剧镜头脚本的判定与编译（剧变流水线）。validate=只读校验：逐镜给出推导时长（9 有效字/秒）、有效字、发声类型、画外音合法性、资产绑定，硬失败与警告分开列出；preview=只读预算：在 validate 之上算出每包内容时长与打包方案，不落盘，用于提交前看预算；compile=判定通过后写入 matched JSON（matches/<集号>.matched.json）与单集 package（prompts/<集号>.txt、episode_packages/<集号>/），并回报每包的 content_duration_ms、提交给剧变的整秒时长与素材键顺序。时长：N秒的正整数声明优先；省略时按 9 有效字/秒估算。超过 15 字写作阈值或内建 36 字建议、偏离估算仅警告，可保留长慢镜头；但项目在 project_config.json 的 delivery.max_effective_chars_per_shot 里声明了每镜上限时，超过该上限判失败（按原文语义拆镜，或改掉该项目的这条要求），不删字、不改顺序、不换说话人；无发声镜必须写 发声类型：action，时长由 动作复杂度（简单/一般/较复杂/复杂 = 1/2/3/4 秒）决定，没写就按默认 2 秒计；台词：无、空台词行、出镜人物：无 一律判失败（无声镜整行省略台词行与出镜人物）；旁白/解说/心声/画外声/OS 作为 vo 画外发声保留原文与说话人，提醒核对项目配音；风格/负面词缺失和正文秒数仅警告；只绑定 official=true 且有剧变 asset/material ID 与 URL 的资产；preview/compile 必填 max_submit_seconds：目标分镜实际请求总秒数（在已确认模型能力内），不是自动取模型最大值。只合并同场连续完整镜头，内容加1秒收束不得超过该值，超长单镜拒绝，禁止截断。硬失败时不会写任何文件，也不给打包方案。";
/**
* Register the `drama_shot` tool.
* @param ctx - Host context carrying the tool registry.
* @param config - The silent-shot budget for shots without a complexity label.
*/
function apply(ctx, config = {}) {
	const resolved = { actionShotSeconds: config.actionShotSeconds ?? DEFAULT_ACTION_SHOT_SECONDS };
	ctx.tools.register(defineTool({
		name: "drama_shot",
		description: DESCRIPTION,
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"validate",
					"preview",
					"compile"
				],
				description: "validate=只读校验；preview=只读预算（不落盘）；compile=判定通过后写入 matched JSON 与单集 package。"
			},
			script: {
				type: "string",
				required: true,
				description: "镜头脚本路径（绝对，或相对当前工作目录）。"
			},
			assets: {
				type: "string",
				description: "资产清单 assets_manifest.json 的路径；preview 与 compile 必填，validate 可选——给了才判定资产绑定。"
			},
			project: {
				type: "string",
				description: "项目根目录（含 episodes/、prompts/、matches/、episode_packages/）；compile 必填。给了它就读该项目的 project_config.json（每镜有效字上限等交付要求）；validate/preview 省略时，从脚本所在目录向上找最近的 project_config.json。"
			},
			max_submit_seconds: {
				type: "integer",
				description: "preview/compile 必填：目标分镜实际请求总秒数，含1秒收束且在已确认模型能力内。例如分镜请求8秒就填8，不默认取模型最大值；已配置15或30秒时才填15或30。"
			},
			episode: {
				type: "integer",
				description: "集号（正整数，如 3）；compile 必填，写入时补成两位，如 03。"
			}
		},
		output: {
			schema: RESULT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => await runDramaShot(args, resolved)
	}));
}
//#endregion
export { Config, apply, inject, name };
