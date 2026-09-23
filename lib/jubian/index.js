import { homedir, tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { JUBIAN_TOKEN_REF, JubianClient, JubianError, JubianLedger, checkBudget } from "@deepseek-ai/dsh-jubian";
import { FAILED_STATUSES, MODEL_TASK_TYPES, SUCCESS_STATUSES, VIDEO_TASK_TYPES, alignedReferenceSize, buildImageRequest, buildNativeVideoPreview, buildReferenceObjectKey, buildSubjectSelection, buildSubtitleEraseRequest, buildVideoUpscaleRequest, childrenOf, classifyExistingNativeMatches, classifyNewNativeCandidates, downloadMedia, extractAppScriptUrl, extractTosUploadConfig, findFolder, findFolderById, imageCandidates, isRelatedTaskCandidate, nativeResultUrls, needsUpscale, readAssetList, readAssetPage, readBackIdentity, readEpisodes, readFolderTree, readGeneratedImage, readImageDisplayPrice, readMaterialList, readModels, readReferenceImage, readScript, readStoryboard, readSubtaskPage, readSubtitleTaskId, readTaskList, readTaskPage, readUpscaleTaskId, referenceMaterialItem, resolveImageModel, resolveVideoModel, responseRecords, signTosObjectPut, stableJson, storyboardMaterials, taskIdOf, taskSemanticFields, taskStatusOf, terminalOutcome, validateNativeVideoPreview, verifySubjectSelection, wireText, withGenerationDisabled, withGenerationEnabled } from "@deepseek-ai/dsh-jubian-api";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
//#region lib/types/write.js
/**
* The write path: one paid or state-changing request under a two-phase ledger.
*
* The intent line lands before the request leaves; the settle line lands after
* the response is read. A record with an intent and no settle line is exactly the
* unknown state a timeout produces, and it is the only honest answer to "did that
* already charge me?".
*
* The key is never generated here. A generated key would let a retry after an
* ambiguous outcome bypass the record of the first attempt, which is the only
* thing standing between a timeout and a second charge.
*/
/**
* Require one argument the caller must supply.
*
* A missing argument is a caller error this process can see without any network
* round trip, so it reports `INVALID_ARGUMENT` rather than the envelope code: a
* caller reading "did not match the expected envelope" would look for a provider
* change while the request never left.
* @param value - The argument, or undefined when it was omitted.
* @param name - Argument name, included so the caller knows what to supply.
* @returns The argument, once it is present.
*/
function need(value, name) {
	if (value === void 0) throw new JubianError("INVALID_ARGUMENT", name);
	return value;
}
/**
* Reject a write that carries no usable idempotency key.
*
* Every write method calls this before its first network request, including the
* reads that compile its body: a missing key must fail without spending even a
* read.
* @param value - Caller-supplied key.
* @returns The key, once it is a non-empty string.
*/
function requireKey(value) {
	if (typeof value !== "string" || !value.trim()) throw new JubianError("INVALID_ARGUMENT", "idempotency_key");
	return value;
}
/**
* Required caller arguments per method, checked before any request or ledger write.
*
* The tool schema is one JSON object shared by every method of a tool, so it
* cannot express "required for this method only". Without this table a caller who
* omits such an argument reaches the method body, where the failure surfaces as a
* bare contract error with nothing naming the argument.
*
* Arguments a method derives from what it already reads are deliberately absent:
* `erase_subtitle` and `upscale` read the project from the task row, and
* `submit_video` accepts either a preview file or the pair that locates one, so
* none of those is listed here. `image_generate` is absent for `asset_type`
* because either it or `asset_category` states the category, and the pair is
* checked against each other in the method. `idempotency_key` is absent too —
* {@link requireKey} owns it and names it for every write method.
*/
const REQUIRED_ARGUMENTS = {
	"jubian_catalog.rate": ["standard_id"],
	"jubian_catalog.script": ["script_id"],
	"jubian_catalog.episodes": ["script_id"],
	"jubian_asset.get": ["asset_id"],
	"jubian_asset.list": ["script_id"],
	"jubian_asset.materials": ["script_id"],
	"jubian_asset.generated_image": ["asset_id"],
	"jubian_asset.confirm_casting": ["material_id"],
	"jubian_asset.register": [
		"script_id",
		"asset_name",
		"asset_type",
		"asset_url"
	],
	"jubian_asset.remove": ["asset_id", "script_id"],
	"jubian_asset.upload_reference": ["image_path"],
	"jubian_asset.create_folder": [
		"folder_name",
		"asset_scope_type",
		"root_category_type"
	],
	"jubian_asset.move": [
		"material_ids",
		"target_folder_id",
		"asset_scope_type",
		"root_category_type"
	],
	"jubian_asset.rename": ["material_id", "asset_name"],
	"jubian_video.task": ["task_id"],
	"jubian_video.tasks": ["script_id"],
	"jubian_video.subtasks": ["task_id"],
	"jubian_video.image_generate": [
		"script_id",
		"asset_name",
		"prompt"
	],
	"jubian_video.upscale": ["task_id"],
	"jubian_video.retry": ["task_id"],
	"jubian_storyboard.get": ["storyboard_id"],
	"jubian_storyboard.create": [],
	"jubian_storyboard.save": ["storyboard_id"],
	"jubian_storyboard.generate": ["storyboard_id", "content_duration_ms"],
	"jubian_storyboard.select_assets": ["storyboard_id", "selections"],
	"jubian_storyboard.prepare_video": ["storyboard_id", "project_dir"],
	"jubian_storyboard.erase_subtitle": [
		"task_id",
		"model_id",
		"video_width",
		"video_height"
	],
	"jubian_media.download": [
		"media_url",
		"media_kind",
		"output_path"
	],
	"jubian_organize.index": ["script_id", "project_dir"],
	"jubian_model.preview": [
		"script_id",
		"project_dir",
		"scope",
		"changes"
	],
	"jubian_model.apply": [
		"script_id",
		"project_dir",
		"preview_path"
	]
};
/**
* Reject a call whose method cannot run without an argument the caller omitted.
*
* Runs before dispatch so the failure costs no request, no ledger line and no
* provider state change.
* @param tool - Tool name, e.g. `jubian_storyboard`.
* @param args - The dispatched arguments.
* @throws {JubianError} `INVALID_ARGUMENT` naming the first missing argument.
*/
function requireArguments(tool, args) {
	const method = typeof args.method === "string" ? args.method : "";
	if (tool === "jubian_storyboard" && method === "create" && args.body === void 0 && args.body_path === void 0) throw new JubianError("INVALID_ARGUMENT", "jubian_storyboard create requires body or body_path");
	for (const name of REQUIRED_ARGUMENTS[`${tool}.${method}`] ?? []) if (args[name] === void 0) throw new JubianError("INVALID_ARGUMENT", `${tool} ${method} requires ${name}`);
}
/**
* Canonical hash of a request body, so the ledger can tell two attempts apart.
* @param body - The exact body about to be sent, or undefined for a bodyless write.
* @returns The `sha256:`-prefixed hash of the body's canonical JSON.
*/
function bodyHash(body) {
	return `sha256:${createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex")}`;
}
/**
* Run one write method under the two-phase ledger.
*
* The intent line lands before the request leaves; the settle line lands after
* the response is read. A replayed key for the same method returns the recorded
* outcome and sends nothing; a key owned by another method is rejected.
*
* `body` is an async thunk on purpose, and it is awaited. Some bodies can only be
* compiled by reading the provider first — an image request needs its selectors
* from the live catalogue — and that read must not happen for a key already
* recorded. Building the body lazily is what makes "replayed" mean zero network
* requests rather than one, and awaiting it is what lets the quote below observe
* what that read returned.
* @param ledger - The write-path ledger.
* @param idempotencyKey - Caller-supplied key; required, never generated here.
* @param method - Ledger method name.
* @param body - Computes the exact body about to be sent, or undefined for a bodyless write.
* @param send - Performs the single request, receiving the computed body.
* @param quote - Optional quote snapshot, observed after the body is built.
* @param options - The project the charge belongs to, and an authorization path override.
* @returns The outcome, whether it was replayed, any envelope data, and the spend verdict.
* @throws {JubianError} `BUDGET_EXCEEDED` when a paid call is not covered by the authorization.
*/
async function writeUnderLedger(ledger, idempotencyKey, method, body, send, quote, options) {
	const key = requireKey(idempotencyKey);
	const existing = await ledger.find(key);
	if (existing !== void 0) {
		if (existing.method !== method) throw new JubianError("CONTRACT_CHANGED", "Idempotency key belongs to a different write");
		return {
			replayed: true,
			outcome: existing.outcome ?? "unknown",
			response_sha256: existing.response_sha256,
			data: null
		};
	}
	const payload = await body();
	const quoted = quote?.();
	const scriptId = quoted?.scriptId ?? options?.scriptId;
	let budget;
	const begun = await ledger.beginChecked(key, async () => {
		budget = await checkBudget({
			ledger,
			method,
			...scriptId === void 0 ? {} : { scriptId },
			...quoted === void 0 ? {} : { quote: quoted },
			...options?.authorizationPath === void 0 ? {} : { authorizationPath: options.authorizationPath }
		});
		if (budget.status === "refused") throw new JubianError("BUDGET_EXCEEDED", budget.reason);
		return {
			idempotencyKey: key,
			method,
			requestSha256: bodyHash(payload),
			...scriptId === void 0 ? {} : { scriptId },
			...budget.chargedAmount === void 0 ? {} : { quotedAmount: budget.chargedAmount },
			...budget.chargedUnit === void 0 ? {} : { quoteUnit: budget.chargedUnit },
			...quoted?.standardId === void 0 ? {} : { quoteStandardId: quoted.standardId },
			...quoted?.observedAt === void 0 ? {} : { quoteObservedAt: quoted.observedAt }
		};
	});
	const budgetSummary = budget === void 0 ? void 0 : {
		status: budget.status,
		reason: budget.reason,
		settledCents: budget.settledCents,
		reservedCents: budget.reservedCents
	};
	if (begun.replayed) {
		if (begun.record.method !== method || begun.record.request_sha256 !== bodyHash(payload)) throw new JubianError("CONTRACT_CHANGED", "Idempotency key belongs to a different write");
		return {
			replayed: true,
			outcome: begun.record.outcome ?? "unknown",
			response_sha256: begun.record.response_sha256,
			data: null,
			...budgetSummary === void 0 ? {} : { budget: budgetSummary }
		};
	}
	if (budgetSummary === void 0) throw new JubianError("CONTRACT_CHANGED", "Fresh write has no budget decision");
	try {
		const response = await send(payload);
		const code = response.transport.application_code;
		const http = response.transport.http_status;
		const outcome = http !== null && http >= 200 && http < 300 && (code === 0 || code === 200) ? "accepted" : "unknown";
		await ledger.settle(key, {
			httpStatus: http,
			applicationCode: code,
			responseSha256: response.response_sha256,
			outcome
		});
		return {
			replayed: false,
			outcome,
			response_sha256: response.response_sha256,
			data: response.data,
			budget: budgetSummary
		};
	} catch (error) {
		await ledger.settle(key, {
			httpStatus: null,
			applicationCode: null,
			responseSha256: null,
			outcome: "unknown"
		});
		throw error;
	}
}
//#endregion
//#region lib/types/native.js
/**
* The storyboard-native video flow: selection, free preparation and the one paid PUT.
*
* `jubian-api` decides *what* is allowed — the preview's shape, the fingerprint,
* the claim rules. This module supplies the I/O around those decisions and keeps
* three of them non-negotiable:
*
* - **Preparation never writes remotely.** It reads the live storyboard, the
*   subject picker and the model catalogue, then writes one preview file into
*   `<project>/video_tasks/`. No PUT, no task creation, no charge.
* - **Submission is one PUT at most, ever.** The key is the preview's own
*   fingerprint, so a preview can only ever cause one request, and a failed or
*   ambiguous response is reconciled rather than retried.
* - **Selection is free by construction.** Its body is always `isGenerate=0`,
*   and the flow re-reads both the task list and the storyboard afterwards to
*   prove that no task was created and that the saved order is the planned one.
*
* The task list is read as a complete, paged snapshot with drift and duplicate
* detection: a partial list would make "no task appeared" an unsafe conclusion,
* and that conclusion is what authorizes a paid PUT.
*/
/** The provider's page cap for task and material listings. */
const MAX_PAGES = 20;
/** Rows requested per task-list page. */
const TASK_PAGE_SIZE = 100;
/** Rows requested per subject-material page. */
const SUBJECT_PAGE_SIZE = 100;
/** Cap on related tasks hydrated from one snapshot, so reconciliation stays bounded. */
const MAX_HYDRATED_TASKS = 100;
/** Refuse one call whose input or provider state does not match the contract. */
function fail$2() {
	throw new JubianError("CONTRACT_CHANGED");
}
function object$2(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new JubianError("CONTRACT_CHANGED");
	return value;
}
/**
* Parse a positive safe integer from a number or a trimmed decimal digit string.
* @param value - Untrusted input or provider field.
* @returns The parsed positive integer.
* @throws JubianError with CONTRACT_CHANGED when the value is not a positive safe integer.
*/
function positiveInteger(value) {
	const candidate = typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
	if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) throw new JubianError("CONTRACT_CHANGED");
	return candidate;
}
/** Read one paged envelope, refusing a page whose rows cannot be listed. */
function pageOf(value) {
	if (Array.isArray(value)) return {
		rows: value.map(object$2),
		total: null
	};
	const record = object$2(value);
	const total = typeof record.total === "number" && Number.isSafeInteger(record.total) ? record.total : null;
	const rows = record.rows ?? record.list;
	if (!Array.isArray(rows)) throw new JubianError("CONTRACT_CHANGED");
	return {
		rows: rows.map(object$2),
		total
	};
}
/**
* Read every video task of one project as one complete snapshot.
*
* Page totals are cross-checked and duplicate stable ids are refused, because
* the before/after id sets are the only boundary that can claim a task: an
* incomplete list would turn "this task is new" into a guess.
* @param client - Jubian transport.
* @param scriptId - Project id.
* @returns Every task record the provider lists, in provider order.
*/
async function listAllVideoTasks(client, scriptId) {
	const collected = [];
	const stable = /* @__PURE__ */ new Set();
	let knownTotal = null;
	for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
		const page = pageOf((await client.request({
			method: "GET",
			path: `/admin/aigc/video/task/list?scriptId=${scriptId}&pageNum=${pageNum}&pageSize=${TASK_PAGE_SIZE}&orderByColumn=createTime&orderBy=desc`
		})).data);
		if (page.total !== null) {
			if (page.total < 0 || knownTotal !== null && page.total !== knownTotal) throw new JubianError("CONTRACT_CHANGED");
			knownTotal = page.total;
		}
		for (const record of page.rows) {
			const taskId = taskIdOf(record);
			if (taskId === null) continue;
			if (stable.has(taskId)) throw new JubianError("CONTRACT_CHANGED");
			stable.add(taskId);
			collected.push(record);
		}
		if (knownTotal !== null) {
			if (collected.length > knownTotal) throw new JubianError("CONTRACT_CHANGED");
			if (collected.length === knownTotal) return collected;
			if (page.rows.length < TASK_PAGE_SIZE) throw new JubianError("CONTRACT_CHANGED");
		} else if (page.rows.length < TASK_PAGE_SIZE) return collected;
	}
	throw new JubianError("CONTRACT_CHANGED");
}
/** Read every child result of one task, in provider order. */
async function listSubtasks(client, taskId) {
	return responseRecords((await client.request({
		method: "POST",
		path: "/admin/aigc/video/task/sub/list?pageNum=1&pageSize=100&orderByColumn=createTime&orderBy=desc",
		body: { aigcVideoTaskId: taskId }
	})).data);
}
/** Read every active subject-setting row of one project as one complete snapshot. */
async function listAllSubjectMaterials(client, scriptId) {
	const collected = [];
	let knownTotal = null;
	for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
		const page = pageOf((await client.request({
			method: "GET",
			path: `/aigc/material/list?scriptId=${scriptId}&isUsed=1&pageNum=${pageNumber}&pageNumber=${pageNumber}&pageSize=${SUBJECT_PAGE_SIZE}`
		})).data);
		if (page.total !== null) {
			if (page.total < 0 || knownTotal !== null && page.total !== knownTotal) throw new JubianError("CONTRACT_CHANGED");
			knownTotal = page.total;
		}
		collected.push(...page.rows);
		if (knownTotal !== null) {
			if (collected.length > knownTotal) throw new JubianError("CONTRACT_CHANGED");
			if (collected.length === knownTotal) return collected;
			if (page.rows.length === 0) throw new JubianError("CONTRACT_CHANGED");
		} else if (page.rows.length < SUBJECT_PAGE_SIZE) return collected;
	}
	throw new JubianError("CONTRACT_CHANGED");
}
/** Read one task's detail, refusing an unreadable body. */
async function taskDetail(client, taskId) {
	return object$2((await client.request({
		method: "GET",
		path: `/admin/aigc/video/task/${taskId}`
	})).data);
}
/** Read one parent asset, refusing a body that does not state the requested id. */
async function parentAsset(client, assetId) {
	const requested = wireText(assetId);
	if (requested === null) fail$2();
	const asset = object$2((await client.request({
		method: "GET",
		path: `/aigc/asset/${requested}`
	})).data);
	if (wireText(asset.id) !== requested) throw new JubianError("CONTRACT_CHANGED");
	return asset;
}
/** Read the live storyboard snapshot, refusing a body that is not the requested storyboard. */
async function storyboardSnapshot(client, storyboardId) {
	const storyboard = object$2((await client.request({
		method: "GET",
		path: `/aigc/storyboard/${storyboardId}`
	})).data);
	if (positiveInteger(storyboard.id) !== storyboardId) throw new JubianError("CONTRACT_CHANGED");
	return storyboard;
}
/**
* Load the trusted inputs a native preview is built from.
*
* Every ordered material is resolved to exactly one active subject-setting row
* and one parent asset in the same project, and the asset's official URL must
* equal the row's: these are the identities the paid PUT will translate, so a
* field that disagrees is refused while the call is still free.
* @param client - Jubian transport.
* @param storyboardId - The storyboard to prepare.
* @returns The live storyboard and its ordered, enriched parent assets.
*/
async function loadLiveInputs(client, storyboardId) {
	const storyboard = await storyboardSnapshot(client, storyboardId);
	const scriptId = positiveInteger(storyboard.scriptId);
	const { materials } = storyboardMaterials(storyboard);
	const byId = /* @__PURE__ */ new Map();
	const ordered = [];
	for (const material of materials) {
		const parentId = wireText(material.materialAssetId ?? material.assetId);
		if (parentId === null || parentId === "") throw new JubianError("CONTRACT_CHANGED");
		const key = parentId;
		let asset = byId.get(key);
		if (asset === void 0) {
			asset = await parentAsset(client, parentId);
			if (positiveInteger(asset.scriptId) !== scriptId) throw new JubianError("CONTRACT_CHANGED");
			byId.set(key, asset);
		}
		ordered.push(asset);
	}
	const rows = await listAllSubjectMaterials(client, scriptId);
	const rowsByParent = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const parent = wireText(row.assetId);
		if (parent === null || parent === "") continue;
		if (!byId.has(parent)) continue;
		rowsByParent.set(parent, [...rowsByParent.get(parent) ?? [], row]);
	}
	const trustedParents = /* @__PURE__ */ new Map();
	for (const [parentId, asset] of byId) {
		const matches = rowsByParent.get(parentId) ?? [];
		if (matches.length !== 1) fail$2();
		const row = matches[0] ?? fail$2();
		if (positiveInteger(row.scriptId) !== scriptId) throw new JubianError("CONTRACT_CHANGED");
		const isUsed = row.isUsed;
		if (!(typeof isUsed === "number" && isUsed === 1 || typeof isUsed === "string" && isUsed.trim() === "1") || (wireText(row.hsAssetStatus) ?? "").trim().toLowerCase() !== "active") throw new JubianError("CONTRACT_CHANGED");
		const trusted = typeof row.hsAssetId === "string" ? row.hsAssetId.trim() : typeof row.hsAssetId === "number" && row.hsAssetId > 0 ? row.hsAssetId : null;
		const rowUrl = typeof row.assetUrl === "string" ? row.assetUrl : null;
		const parentUrl = typeof asset.url === "string" ? asset.url : typeof asset.assetUrl === "string" ? asset.assetUrl : null;
		if (trusted === null || trusted === "" || rowUrl === null || rowUrl !== parentUrl) throw new JubianError("CONTRACT_CHANGED");
		const trustedKey = `t:${wireText(trusted) ?? ""}`;
		const existing = trustedParents.get(trustedKey);
		if (existing !== void 0 && existing !== parentId) throw new JubianError("CONTRACT_CHANGED");
		trustedParents.set(trustedKey, parentId);
		asset.official = true;
		asset.asset_status = "confirmed";
		asset.asset_confirmation = "verified";
		asset.hsAssetId = trusted;
		asset.hsAssetStatus = row.hsAssetStatus;
		asset.isUsed = row.isUsed;
		asset.assetUrl = rowUrl;
	}
	return {
		storyboard,
		assets: ordered
	};
}
/** The live catalogue of video-generation models. */
async function videoCatalogue(client) {
	return (await client.request({
		method: "GET",
		path: "/model/charge/getSelectList?taskType=1"
	})).data;
}
/** Build the exact preview from live provider state, without writing anything. */
async function livePreview(client, storyboardId, createdAt) {
	const { storyboard, assets } = await loadLiveInputs(client, storyboardId);
	return buildNativeVideoPreview({
		storyboard,
		assets,
		models: await videoCatalogue(client),
		createdAt
	});
}
/** Read a positive episode id; missing or malformed values cannot exclude a candidate. */
function episodeIdOf(value) {
	if (typeof value !== "number" && (typeof value !== "string" || !/^[0-9]+$/.test(value.trim()))) return null;
	const id = Number(value);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}
/** Whether one task record names this storyboard in its own `storyboardId` field. */
function statesStoryboard(record, storyboardId) {
	return wireText(taskSemanticFields(record).storyboardId) === String(storyboardId);
}
/**
* Hydrate every task of one snapshot that is provably this storyboard's.
*
* A project holds the tasks of every storyboard it ever submitted, and most task rows
* state no `storyboardId`. Such a row is this storyboard's only when its detail or one
* child result names this storyboard; a row that proves neither belongs to another
* storyboard, and its empty child list says nothing about this submission.
* @param client - Jubian transport.
* @param records - A complete task snapshot.
* @param scriptId - Project id.
* @param storyboardId - Storyboard id.
* @param episodeId - Live preview episode; only explicit valid differences exclude tasks before the cap.
* @returns One hydrated entry per provably related task, each with its storyboard-matching children.
*/
async function hydrateRelated(client, records, scriptId, storyboardId, episodeId) {
	const expectedEpisode = episodeIdOf(episodeId);
	const related = records.filter((record) => {
		if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) return false;
		const episode = episodeIdOf(record.episodeId ?? record.episode_id);
		return expectedEpisode === null || episode === null || episode === expectedEpisode;
	});
	if (related.length > MAX_HYDRATED_TASKS) throw new JubianError("CONTRACT_CHANGED");
	const hydrated = [];
	for (const record of related) {
		const taskId = taskIdOf(record);
		if (taskId === null) throw new JubianError("CONTRACT_CHANGED");
		const task = await taskDetail(client, taskId);
		const children = childrenOf(await listSubtasks(client, taskId), storyboardId);
		if (children.length === 0 && !statesStoryboard(record, storyboardId) && !statesStoryboard(task, storyboardId)) continue;
		hydrated.push({
			taskId,
			task,
			children
		});
	}
	return hydrated;
}
/** Read the ordered trusted identity a preview claims. */
function expectedIdentity(preview) {
	return preview.assetSummary.orderedAssets.map((asset) => ({
		assetId: asset.assetId,
		materialName: asset.materialName,
		imageUrl: asset.imageUrl
	}));
}
/** Build the expectation one claim is checked against. */
function expectationOf(preview, beforeTaskIds) {
	const modelConfig = typeof preview.payload.modelConfig === "string" ? preview.payload.modelConfig : "{}";
	const entries = Object.entries(JSON.parse(modelConfig));
	const expectedModel = [
		"platformId",
		"modelId",
		"standardId",
		"genType",
		"modelGenerationTypeId",
		"videoStandardId",
		"duration",
		"ratio",
		"resolution",
		"genNum"
	].map((field) => {
		const value = entries.find(([key]) => key === field)?.[1];
		const rendered = value === void 0 || value === null || value === "" ? null : wireText(value);
		if (rendered === null) throw new JubianError("CONTRACT_CHANGED");
		return [field, rendered];
	});
	const prompt = entries.find(([key]) => key === "prompt")?.[1];
	if (typeof prompt !== "string" || !prompt) throw new JubianError("CONTRACT_CHANGED");
	return {
		scriptId: preview.scriptId,
		storyboardId: preview.storyboardId,
		episodeId: Number(preview.payload.episodeId),
		expectedIdentity: expectedIdentity(preview),
		expectedModel,
		expectedPrompt: prompt,
		beforeTaskIds
	};
}
/** Turn one claim into the model-facing status plus the reconciliation guidance it earns. */
function claimReport(claim, preview) {
	if (claim.status === "matched") {
		const identity = readBackIdentity(claim.child, expectedIdentity(preview));
		const urls = nativeResultUrls([claim.task, claim.child]);
		if (identity.status === "subject_identity_lost") return {
			status: "subject_identity_lost",
			task_id: claim.taskId,
			reason: identity.reason,
			next: "身份缺失是终态：不要再提交、不要重建 preview。人工核对该任务的子项身份后再决定。"
		};
		return {
			status: "submitted",
			task_id: claim.taskId,
			task_status: taskStatusOf(claim.task, claim.child) || null,
			result_urls: urls,
			next: "任务已由这一次 storyboard PUT 创建，子项身份完整。生成是异步的，不要在这里等待——稍后用 jubian_video subtasks 回读该任务（可带 delivery_resolution）。"
		};
	}
	if (claim.status === "subject_identity_lost") return {
		status: "subject_identity_lost",
		task_id: claim.taskId,
		next: "子项缺少 assetId/materialName/imageUrl：终态，不要重放提交、不要改用 direct POST。人工核对。"
	};
	if (claim.status === "reconcile_conflict") return {
		status: "reconcile_conflict",
		task_id: null,
		next: "出现多个候选或证据不完整：只做对账。不要再次提交同一个 preview。"
	};
	return {
		status: "reconcile_required",
		task_id: null,
		next: "本次 PUT 之后还没有看到唯一的新任务。用同一个 preview 和同一个 idempotency_key 再调一次 submit_video（只会重新对账，绝不会再发 PUT），或用 jubian_video tasks/subtasks 回读。"
	};
}
/**
* Write one JSON file atomically inside its destination directory.
* @param path - Destination path.
* @param value - Owned JSON value to persist.
*/
async function atomicWriteJson(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}
/**
* Read `project_config.json` and bind it to the live project id.
* @param projectDir - The project directory the preview will be written into.
* @param scriptId - The live storyboard's project id.
* @returns The resolved project root and the configured project id.
* @throws {JubianError} `CONTRACT_CHANGED` when the file is missing, invalid or bound to another project.
*/
async function validateProjectBinding(projectDir, scriptId) {
	const projectRoot = resolve(projectDir);
	let text;
	try {
		text = await readFile(join(projectRoot, "project_config.json"), "utf8");
	} catch {
		throw new JubianError("CONTRACT_CHANGED");
	}
	let parsed;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		throw new JubianError("CONTRACT_CHANGED");
	}
	const configured = positiveInteger(object$2(parsed).jubian_script_id);
	if (configured !== positiveInteger(scriptId)) throw new JubianError("CONTRACT_CHANGED");
	return {
		project_root: projectRoot,
		script_id: configured
	};
}
/** Resolve the project root that owns one prepared preview. */
function projectRootOfPreview(previewPath) {
	const segments = resolve(previewPath).split(sep);
	for (let index = segments.length - 2; index >= 0; index -= 1) if (segments[index] === "video_tasks") return segments.slice(0, index).join(sep);
	throw new JubianError("CONTRACT_CHANGED");
}
/**
* Prepare one storyboard-native video package without any remote write.
* @param client - Jubian transport.
* @param args - `storyboard_id`, `project_dir` and an optional `content_duration_ms` cross-check.
* @returns The persisted preview, its path and the exact next step.
* @throws {JubianError} `CONTRACT_CHANGED` when any live identity or setting fails.
*/
async function prepareVideoMethod(client, args) {
	const storyboardId = positiveInteger(need(args.storyboard_id));
	const preview = await livePreview(client, storyboardId, (/* @__PURE__ */ new Date()).toISOString());
	const binding = await validateProjectBinding(need(args.project_dir), preview.scriptId);
	const duration = positiveInteger(JSON.parse(String(preview.payload.modelConfig)).duration);
	const contentDurationMs = (duration - 1) * 1e3;
	if (args.content_duration_ms !== void 0 && args.content_duration_ms !== contentDurationMs) throw new JubianError("CONTRACT_CHANGED");
	const root = resolve(binding.project_root, "video_tasks");
	const destination = resolve(root, `storyboard-${storyboardId}-${preview.idempotencyKey.slice(0, 12)}.storyboard-native.prepared.json`);
	if (!destination.startsWith(`${root}${sep}`)) throw new JubianError("CONTRACT_CHANGED");
	await atomicWriteJson(destination, preview);
	return {
		...preview,
		preview_path: destination,
		content_duration_ms: contentDurationMs,
		storyboard_duration_seconds: duration,
		next: `prepare 只写 preview：不 PUT、不创建任务、不收费。逐字段审阅后调用 submit_video，并把它自己的 idempotency_key（${preview.idempotencyKey}）原样传入。`
	};
}
/**
* Select the storyboard's subject assets and save them with generation disabled.
* @param client - Jubian transport.
* @param ledger - Write-path ledger.
* @param args - `storyboard_id`, ordered `selections` and the caller's `idempotency_key`.
* @returns The before/after state, the read-back verification and the task audit.
* @throws {JubianError} `CONTRACT_CHANGED` when any identity, order or read-back rule fails.
*/
async function selectAssetsMethod(client, ledger, args) {
	const key = requireKey(args.idempotency_key);
	const storyboardId = positiveInteger(need(args.storyboard_id));
	const storyboard = await storyboardSnapshot(client, storyboardId);
	const scriptId = positiveInteger(storyboard.scriptId);
	const selections = need(args.selections);
	if (!Array.isArray(selections) || selections.length === 0) throw new JubianError("CONTRACT_CHANGED");
	const subjectRows = await listAllSubjectMaterials(client, scriptId);
	const parents = [];
	for (const assetId of [...new Set(selections.map((selection) => String(selection.asset_id)))]) parents.push(await parentAsset(client, assetId));
	const plan = buildSubjectSelection({
		storyboard,
		selections,
		subjectRows,
		parentAssets: parents
	});
	if (plan.status === "already_applied") return {
		operation: plan.operation,
		status: "already_applied",
		applied: false,
		scriptId: plan.scriptId,
		storyboardId: plan.storyboardId,
		before: plan.before,
		after: plan.after,
		next: "分镜已经保存的就是这个选择：没有发送 PUT，也没有收费。"
	};
	const beforeRecords = await listAllVideoTasks(client, scriptId);
	const beforeIds = /* @__PURE__ */ new Set();
	for (const record of beforeRecords) {
		if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) continue;
		const taskId = taskIdOf(record);
		if (taskId === null) throw new JubianError("CONTRACT_CHANGED");
		beforeIds.add(taskId);
	}
	const result = await writeUnderLedger(ledger, key, "storyboard_select_assets", () => plan.payload, (payload) => client.request({
		method: "PUT",
		path: "/aigc/storyboard",
		body: payload ?? fail$2()
	}));
	const afterRecords = await listAllVideoTasks(client, scriptId);
	const newRelated = [];
	for (const record of afterRecords) {
		if (!isRelatedTaskCandidate(record, scriptId, storyboardId)) continue;
		const taskId = taskIdOf(record);
		if (taskId === null) throw new JubianError("CONTRACT_CHANGED");
		if (!beforeIds.has(taskId)) newRelated.push(taskId);
	}
	const verification = verifySubjectSelection(await storyboardSnapshot(client, storyboardId), plan.after);
	if (!verification.matches) throw new JubianError("CONTRACT_CHANGED");
	return {
		...result,
		operation: plan.operation,
		scriptId,
		storyboardId,
		before: plan.before,
		after: plan.after,
		verification,
		status: newRelated.length > 0 ? "billing_safety_violation" : "applied",
		applied: true,
		paid_requests: 0,
		next: newRelated.length > 0 ? `选择保存（isGenerate=0）不应创建任务，但出现了新任务 ${newRelated.join(", ")}：立即停机人工核对，不要再调用 prepare_video/submit_video。` : "选择已保存并回读一致（isGenerate=0，未收费）。下一步是 prepare_video。"
	};
}
/** Resolve the preview file a submission must use, refusing ambiguity. */
async function resolvePreviewPath(args) {
	if (args.preview_path !== void 0) return resolve(args.preview_path);
	const storyboardId = positiveInteger(need(args.storyboard_id));
	const root = resolve(need(args.project_dir), "video_tasks");
	let names;
	try {
		names = await readdir(root);
	} catch {
		return fail$2();
	}
	const matches = names.filter((name) => name.startsWith(`storyboard-${storyboardId}-`) && name.endsWith(".storyboard-native.prepared.json"));
	if (matches.length !== 1) fail$2();
	return resolve(root, matches[0] ?? fail$2());
}
/**
* Submit one prepared, approved storyboard-native video package.
*
* The key must be the preview's own fingerprint, which makes one preview equal to
* one PUT for all time. Before that PUT the flow takes a complete task snapshot
* twice and refuses to continue if it drifted; after it, a second snapshot is the
* only evidence that may claim a task. A PUT that fails for any reason — timeout,
* 5xx, connection loss — is treated as ambiguous: the submission records
* `unknown` and returns reconciliation guidance instead of resending.
* @param client - Jubian transport.
* @param ledger - Write-path ledger.
* @param args - `preview_path` (or `project_dir` plus `storyboard_id`) and `idempotency_key`.
* @returns The submission verdict, the claimed task when there is one, and the next step.
* @throws {JubianError} `CONTRACT_CHANGED` when the preview is stale, mismatched or not this plugin's own.
*/
/**
* What the classifier actually read for each candidate it could not decide.
*
* A bare `reconcile_conflict` is not actionable: one verdict covers an unreadable
* storyboard id, a task whose child lost its identity, and a task that is simply
* not this submission. This reports the fields `isRelatedTaskCandidate` and
* `taskSemanticFields` read, so the next conflict names its own cause. Read-only:
* it re-derives nothing the classifier did not already consult.
* @param candidates - The hydrated tasks the conflict was decided over.
* @param expectation - The submission identity the classifier compared against.
* @returns One row per related candidate, with `storyboard_id_read` null when unreadable.
*/
function conflictEvidence(candidates, expectation) {
	return candidates.filter((candidate) => isRelatedTaskCandidate(candidate.task, expectation.scriptId, expectation.storyboardId)).map((candidate) => {
		const semantic = taskSemanticFields(candidate.task);
		return {
			task_id: candidate.taskId,
			task_name: candidate.task.taskName ?? candidate.task.task_name ?? null,
			storyboard_id_read: wireText(semantic.storyboardId),
			episode_id: episodeIdOf(candidate.task.episodeId ?? candidate.task.episode_id),
			children: candidate.children.length
		};
	});
}
/**
* Reconcile a frozen native-video preview and submit at most one charged storyboard PUT for its key.
* @param client - Authenticated transport for live reads and the optional submission.
* @param ledger - Write ledger used to reserve the charge and prevent a repeated PUT.
* @param args - Preview locator, optional project/storyboard identity, and matching idempotency key.
* @returns Submission or reconciliation evidence, including unresolved outcomes without automatic resubmission.
*/
async function submitVideoMethod(client, ledger, args) {
	const key = need(args.idempotency_key);
	if (!key.trim()) throw new JubianError("CONTRACT_CHANGED");
	const previewPath = await resolvePreviewPath(args);
	let parsed;
	try {
		parsed = JSON.parse(await readFile(previewPath, "utf8"));
	} catch {
		throw new JubianError("CONTRACT_CHANGED");
	}
	const preview = validateNativeVideoPreview(parsed);
	if ((await validateProjectBinding(projectRootOfPreview(previewPath), preview.scriptId)).script_id !== preview.scriptId) throw new JubianError("CONTRACT_CHANGED");
	if (key !== preview.idempotencyKey) throw new JubianError("CONTRACT_CHANGED");
	const recorded = await ledger.find(key);
	if (recorded !== void 0) {
		const claim = classifyExistingNativeMatches(await hydrateRelated(client, await listAllVideoTasks(client, preview.scriptId), preview.scriptId, preview.storyboardId, preview.payload.episodeId), expectationOf(preview, []));
		return {
			replayed: true,
			outcome: recorded.outcome ?? "unknown",
			response_sha256: recorded.response_sha256,
			preview_path: previewPath,
			idempotency_key: key,
			...claimReport(claim, preview),
			next: `同一个 idempotency_key 已有一条记录（outcome=${recorded.outcome ?? "unknown"}），因此不会再发送任何 PUT。上面是对账结果：submitted 表示这次提交确实已经创建了任务；reconcile_required 表示暂时看不到新任务，继续用同一个 key 对账即可。`
		};
	}
	if ((await livePreview(client, preview.storyboardId, preview.createdAt)).idempotencyKey !== preview.idempotencyKey) throw new JubianError("CONTRACT_CHANGED");
	const preflightRecords = await listAllVideoTasks(client, preview.scriptId);
	const preflight = await hydrateRelated(client, preflightRecords, preview.scriptId, preview.storyboardId, preview.payload.episodeId);
	const expectation = expectationOf(preview, []);
	const existing = classifyExistingNativeMatches(preflight, expectation);
	if (existing.status === "reconcile_conflict") return {
		replayed: false,
		outcome: "unknown",
		status: "reconcile_conflict",
		task_id: null,
		preview_path: previewPath,
		candidates: conflictEvidence(preflight, expectation),
		next: "提交前对账发现多个候选或证据不完整：没有发送 PUT。人工核对远端任务后再说。上面的 candidates 是判定时实际读到的字段；storyboard_id_read 为 null 表示那条任务的归属读不出来，它因此被当成可能属于本分镜。"
	};
	if (existing.status === "matched") return {
		replayed: false,
		outcome: "unknown",
		status: "already_submitted",
		task_id: existing.taskId,
		preview_path: previewPath,
		next: "提交前对账发现这次提交在远端已经存在完全一致的任务：没有发送 PUT。后续用 jubian_video subtasks 回读该任务即可。"
	};
	const beforeRecords = await listAllVideoTasks(client, preview.scriptId);
	const firstIds = preflightRecords.map(taskIdOf).filter((value) => value !== null).sort();
	const secondIds = beforeRecords.map(taskIdOf).filter((value) => value !== null).sort();
	if (beforeRecords.length !== preflightRecords.length || stableJson(firstIds) !== stableJson(secondIds)) return {
		replayed: false,
		outcome: "unknown",
		status: "reconcile_required",
		task_id: null,
		preview_path: previewPath,
		next: "两次全量任务快照不一致（列表在漂移）：没有发送 PUT。稍后重新 prepare 并在稳定时再提交。"
	};
	const beforeTaskIds = beforeRecords.filter((record) => isRelatedTaskCandidate(record, preview.scriptId, preview.storyboardId)).map(taskIdOf).filter((value) => value !== null);
	const beforeAllTaskIds = new Set(secondIds);
	const state = {
		putFailed: false,
		reconciliationFailed: false,
		sent: false,
		appearedIds: [],
		claim: { status: "none" }
	};
	const result = await writeUnderLedger(ledger, key, "storyboard_native_submit", () => preview.payload, async (payload) => {
		let response;
		try {
			response = await client.request({
				method: "PUT",
				path: "/aigc/storyboard",
				body: payload ?? fail$2()
			});
		} catch {
			state.putFailed = true;
			return {
				transport: {
					http_status: null,
					application_code: null
				},
				response_sha256: null,
				data: null
			};
		}
		state.sent = true;
		try {
			const afterRecords = await listAllVideoTasks(client, preview.scriptId);
			state.appearedIds = afterRecords.map(taskIdOf).filter((value) => value !== null).filter((id) => !beforeAllTaskIds.has(id));
			state.claim = classifyNewNativeCandidates(await hydrateRelated(client, afterRecords, preview.scriptId, preview.storyboardId, preview.payload.episodeId), expectationOf(preview, beforeTaskIds));
		} catch {
			state.reconciliationFailed = true;
		}
		return response;
	}, void 0, { scriptId: preview.scriptId });
	const putSent = state.sent || result.replayed;
	const putOutcome = result.outcome;
	const acceptedUnclaimed = putOutcome === "accepted" && state.claim.status === "reconcile_conflict";
	const report = state.reconciliationFailed ? {
		status: "reconcile_required",
		task_id: null,
		result_urls: [],
		next: "PUT 已发出但第二次快照或认领失败：只做对账。用同一个 preview 和同一个 key 再调一次 submit_video。"
	} : claimReport(state.claim, preview);
	return {
		...result,
		preview_path: previewPath,
		idempotency_key: key,
		...report,
		status: state.putFailed || acceptedUnclaimed ? "reconcile_required" : report.status,
		put_sent: putSent,
		put_outcome: putOutcome,
		...acceptedUnclaimed ? { claim_status: "reconcile_conflict" } : {},
		...state.appearedIds.length > 0 ? { new_task_ids: state.appearedIds } : {},
		put_ambiguous: state.putFailed,
		before_task_ids: beforeTaskIds,
		next: state.putFailed ? "PUT 的结果不明确（超时/5xx/连接中断）：没有任何自动重试，这个 key 也不会再发 PUT。按上面的对账结果处理：submitted 就是已创建，否则继续用同一个 key 对账。" : acceptedUnclaimed ? "PUT 已被提供方受理（很可能已计费），但没有一条候选能被完整认领：不要重新提交这个 preview。按 new_task_ids 回读那些新任务（jubian_video subtasks），或人工核对归属。" : report.next
	};
}
//#endregion
//#region lib/types/naming.js
/**
* The episode-and-category naming convention, and the audit that reports names
* which predate it.
*
* A creation request's name is what a reader of the console's asset library sees
* first, so it is where a caller can make a project's assets line up by episode
* and category. This module composes those names. It never rewrites a name the
* provider already holds: the one rename the console offers is not a capability
* this package publishes, so the audit below only reports.
*/
/** The three asset categories the console's own libraries page on. */
const ASSET_CATEGORIES = [
	"角色",
	"场景",
	"道具"
];
/**
* The provider's own category numbering, which is the same number for an asset's
* `assetType` and for the library a folder is created in.
*
* It is an external contract, not a deployment choice: the console pages on
* exactly these three libraries, so the numbers stay fixed here.
*/
const ASSET_CATEGORY_TYPES = {
	角色: 1,
	场景: 2,
	道具: 3
};
/**
* Name the category one provider category number denotes.
* @param value - An `assetType` or `rootCategoryType` value.
* @returns The category, or null when the number is not one the console pages on.
*/
function categoryOfType(value) {
	return ASSET_CATEGORIES.find((category) => ASSET_CATEGORY_TYPES[category] === value) ?? null;
}
/** Prefixes that name a category in a legacy asset name. */
const CATEGORY_PREFIXES = [
	[/^(scene|场景)[_-]/i, "场景"],
	[/^(prop|道具)[_-]/i, "道具"],
	[/^(character|角色)[_-]/i, "角色"]
];
/** Slugs a scene name carries between its own segments. */
const SCENE_SLUGS = ["日", "夜"];
/**
* Read the category a name declares about itself.
*
* Used by the audit to name assets whose `assetType` disagrees with what their
* name says: a name that reads as a scene while the asset sits in the character
* library is the shape of a creation request that sent the wrong type.
* @param name - One asset name, as the provider or a manifest spells it.
* @param naming - Resolved naming choices.
* @returns The declared category, or null when the name declares none.
*/
function declaredCategory(name, naming) {
	const parts = name.split(naming.separator);
	const fromConvention = segment(parts, 1).trim();
	if (ASSET_CATEGORIES.includes(fromConvention)) return fromConvention;
	for (const [pattern, category] of CATEGORY_PREFIXES) if (pattern.test(name.trim())) return category;
	if (SCENE_SLUGS.some((slug) => parts.includes(slug))) return "场景";
	return null;
}
/**
* Resolve the naming choices one deployment configured.
*
* Called once while the row mounts, so a blank separator or series label fails
* the mount instead of composing a name no reader can split.
* @param options - Configured overrides; omitted fields keep their defaults.
* @returns The separator and series label every composed name uses.
* @throws {Error} When either configured value is blank.
*/
function resolveNaming(options = {}) {
	const separator = options.separator ?? "｜";
	const seriesLabel = options.seriesLabel ?? "全剧";
	if (!separator.trim() || !seriesLabel.trim()) throw new Error("tool-jubian: naming separator and series label must each be a non-blank string");
	return {
		separator,
		seriesLabel
	};
}
/**
* Normalize one episode number to its two-digit spelling.
* @param value - An episode number as a manifest or a caller spells it, such as `2` or `02`.
* @returns The two-digit form, or null when the value is not a number.
*/
function normalizedEpisode(value) {
	const text = String(value).trim();
	return /^[0-9]{1,3}$/.test(text) ? text.padStart(2, "0") : null;
}
/**
* Resolve the episode token that opens a composed name.
* @param value - An episode number (`5` or `05`) or the configured series label.
* @param naming - Resolved naming choices.
* @returns `EP05` for an episode, or the series label for a series-wide asset.
* @throws {JubianError} `INVALID_ARGUMENT` when the value is neither, so a caller learns which
*   argument to correct without a request leaving.
*/
function episodePrefix(value, naming) {
	const text = String(value).trim();
	if (text === naming.seriesLabel) return text;
	const normalized = normalizedEpisode(text);
	if (normalized !== null) return `EP${normalized}`;
	throw new JubianError("INVALID_ARGUMENT", `episode=${text} 既不是集号也不是 ${naming.seriesLabel}`);
}
/**
* Compose the name a creation request carries.
* @param episode - The `episode` argument: an episode number or the series label.
* @param category - One of {@link ASSET_CATEGORIES}.
* @param name - The asset's own name, such as `红包`.
* @param naming - Resolved naming choices.
* @returns `EP05｜道具｜红包`, or `全剧｜角色｜陆沉舟` for a series-wide master.
* @throws {JubianError} `INVALID_ARGUMENT` when the episode or the name is unusable.
*/
function composedAssetName(episode, category, name, naming) {
	const trimmed = name.trim();
	if (!trimmed) throw new JubianError("INVALID_ARGUMENT", "asset_name");
	return [
		episodePrefix(episode, naming),
		category,
		trimmed
	].join(naming.separator);
}
/**
* Compose the sortable prefix of a processing task's name.
* @param episode - The `episode` argument: an episode number or the series label.
* @param packageNumber - Package number within the episode, or undefined for the whole episode.
* @param naming - Resolved naming choices.
* @returns `EP05`, `EP05-P3`, or the series label when no package number was given.
* @throws {JubianError} `INVALID_ARGUMENT` when the episode or the package number is unusable.
*/
function taskPrefix(episode, packageNumber, naming) {
	const prefix = episodePrefix(episode, naming);
	if (packageNumber === void 0) return prefix;
	const text = String(packageNumber).trim();
	if (!/^[0-9]{1,3}$/.test(text)) throw new JubianError("INVALID_ARGUMENT", `package_number=${text}`);
	return `${prefix}-P${text}`;
}
/** Read one segment of a split name, or an empty string when it has fewer. */
function segment(parts, index) {
	return parts[index] ?? "";
}
/**
* Audit one name against the convention.
* @param name - A name as the provider or a manifest spells it.
* @param naming - Resolved naming choices.
* @returns Whether it reads as `EP{nn}｜{类别}｜{名称}` or `{全剧}｜{类别}｜{名称}`.
*/
function auditAssetName(name, naming) {
	const parts = name.split(naming.separator);
	const head = segment(parts, 0);
	const category = segment(parts, 1);
	const leaf = segment(parts, 2);
	if (head !== naming.seriesLabel && !/^EP[0-9]{2,3}$/.test(head)) return {
		conforming: false,
		reason: `缺少集号前缀（应为 EP{两位集数} 或 ${naming.seriesLabel}）`
	};
	if (parts.length < 3) return {
		conforming: false,
		reason: `缺少类别与名称段（应为 {集号}${naming.separator}{类别}${naming.separator}{名称}）`
	};
	if (!ASSET_CATEGORIES.includes(category)) return {
		conforming: false,
		reason: `类别段 ${category} 不是 ${ASSET_CATEGORIES.join("、")}`
	};
	if (!leaf.trim()) return {
		conforming: false,
		reason: "名称段为空"
	};
	return {
		conforming: true,
		reason: null
	};
}
/**
* Read the episode token a name already carries.
*
* A task name is the provider's own field, so a caller cannot assume one was
* composed here; this reads a token a name carries whatever wrote it.
* @param name - One provider name, such as `EP05-P3-sb12-去字幕`.
* @param naming - Resolved naming choices.
* @returns `EP05`, the series label, or null when the name carries neither.
*/
function carriedEpisode(name, naming) {
	for (const segment of name.split(naming.separator)) for (const token of segment.split("-")) {
		if (token === naming.seriesLabel) return token;
		if (/^EP[0-9]{2,3}$/.test(token)) return token;
	}
	return null;
}
//#endregion
//#region lib/types/folders.js
/** The two asset scopes the console offers, as the provider numbers them. */
const ASSET_SCOPES = {
	team: 1,
	personal: 2
};
/** Read one library's folder tree. */
async function libraryTree(client, scope, categoryType) {
	return readFolderTree((await client.request({
		method: "GET",
		path: `/aigc/assetFolder/tree?assetScopeType=${scope}&rootCategoryType=${categoryType}`
	})).data);
}
/**
* Answer a key that already has a record, before the free precondition read.
*
* The precondition reads below decide "this folder already exists" from the live
* tree, and after a successful create that same tree is exactly what a repeated
* key would find — so without this check a replay would report a folder the
* first call created as a refusal. Asking the ledger first keeps the package-wide
* meaning of a repeated key: the recorded outcome, and nothing sent.
* @param ledger - Write-path ledger.
* @param key - Caller-supplied key, already proven usable.
* @returns The recorded outcome, or null when this key has no record yet.
*/
async function replayed(ledger, key) {
	const existing = await ledger.find(key);
	if (existing === void 0) return null;
	return {
		replayed: true,
		outcome: existing.outcome ?? "unknown",
		response_sha256: existing.response_sha256,
		data: null,
		sent: false,
		status: "replayed",
		next: "这个 idempotency_key 已有记录：本次没有发送请求，也没有改动远端。用 jubian_organize 重读一次索引即可看到现状。"
	};
}
/** Reject a scope or category the provider has no library for. */
function requireLibrary(scope, categoryType) {
	if (!Object.values(ASSET_SCOPES).includes(scope) || ![
		1,
		2,
		3
	].includes(categoryType)) throw new JubianError("INVALID_ARGUMENT", `asset_scope_type=${scope} / root_category_type=${categoryType}`);
}
/**
* `create_folder` — make one folder inside a category library.
*
* The folder is created under `parent_id`, or directly under the library root
* when the caller names no parent: the root's own identifier is the category
* number, which is what the console passes. A sibling that already carries the
* name is reported instead of creating a second folder with it.
* @param client - Jubian transport.
* @param ledger - Write-path ledger.
* @param args - `folder_name`, `asset_scope_type`, `root_category_type`, optional `parent_id` and key.
* @returns The created folder's identifier once the tree shows it, or the existing sibling.
* @throws {JubianError} `INVALID_ARGUMENT` for a missing or unusable argument.
*/
async function createFolderMethod(client, ledger, args) {
	const key = requireKey(args.idempotency_key);
	const recorded = await replayed(ledger, key);
	if (recorded !== null) return recorded;
	const name = need(args.folder_name, "folder_name").trim();
	if (!name) throw new JubianError("INVALID_ARGUMENT", "folder_name");
	const scope = need(args.asset_scope_type, "asset_scope_type");
	const categoryType = need(args.root_category_type, "root_category_type");
	requireLibrary(scope, categoryType);
	const parentId = args.parent_id ?? categoryType;
	const existing = findFolder(await libraryTree(client, scope, categoryType), name, args.parent_id);
	if (existing !== null) return {
		sent: false,
		status: "folder_exists",
		folder_id: existing.folder_id,
		name,
		parent_id: parentId,
		next: "同名文件夹已经存在，没有发送任何请求。要建一个不同层级的同名文件夹，请给出 parent_id；要往里放资产，直接用这个 folder_id 调 move。"
	};
	const result = await writeUnderLedger(ledger, key, "asset_folder_create", () => ({
		folderName: name,
		parentId,
		assetScopeType: scope,
		rootCategoryType: categoryType
	}), (sent) => client.request({
		method: "POST",
		path: "/aigc/assetFolder/add",
		body: need(sent)
	}));
	const created = findFolder(await libraryTree(client, scope, categoryType), name, args.parent_id);
	return {
		...result,
		sent: true,
		status: "created",
		folder_id: created?.folder_id ?? null,
		name,
		parent_id: parentId,
		asset_scope_type: scope,
		root_category_type: categoryType,
		confirmed: created !== null,
		next: created === null ? "请求已被受理，但回读的文件夹树里还没有这个名字：稍后重读树确认，不要重复创建。" : `文件夹已建好（folder_id=${created.folder_id}）。把资产放进去用 move；要按规范命名新资产，用 image_generate 或 rename 的 episode 与 asset_category。`
	};
}
/**
* `move` — put assets into a folder.
*
* `root_category_type` is required because it selects the tree this method reads
* to prove the target exists; the request body carries only the three fields the
* console sends. Moving back to a library root is allowed by naming the library's
* own identifier — the category number — as the target.
* @param client - Jubian transport.
* @param ledger - Write-path ledger.
* @param args - `material_ids`, `target_folder_id`, `asset_scope_type`, `root_category_type` and a key.
* @returns The move's outcome, or a decidable refusal when the target is not there.
* @throws {JubianError} `INVALID_ARGUMENT` for a missing or unusable argument.
*/
async function moveMethod(client, ledger, args) {
	const key = requireKey(args.idempotency_key);
	const recorded = await replayed(ledger, key);
	if (recorded !== null) return recorded;
	const ids = need(args.material_ids, "material_ids");
	if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new JubianError("INVALID_ARGUMENT", "material_ids");
	const target = need(args.target_folder_id, "target_folder_id");
	const scope = need(args.asset_scope_type, "asset_scope_type");
	const categoryType = need(args.root_category_type, "root_category_type");
	requireLibrary(scope, categoryType);
	const tree = await libraryTree(client, scope, categoryType);
	if (target !== categoryType && findFolderById(tree, target) === null) return {
		sent: false,
		status: "target_folder_missing",
		target_folder_id: target,
		asset_scope_type: scope,
		root_category_type: categoryType,
		next: `目标文件夹不在该库的文件夹树里，没有发送任何请求。先重读文件夹树拿到真实 folder_id；要把资产放回库根目录，把 target_folder_id 传成 ${categoryType}。`
	};
	return {
		...await writeUnderLedger(ledger, key, "asset_move", () => ({
			ids,
			targetFolderId: target,
			assetScopeType: scope
		}), (sent) => client.request({
			method: "PUT",
			path: "/aigc/material/move",
			body: need(sent)
		})),
		sent: true,
		status: "moved",
		material_ids: ids,
		target_folder_id: target,
		asset_scope_type: scope,
		root_category_type: categoryType,
		next: "移动已被提供方受理。用 jubian_organize 重读一次索引即可看到资产所在的新文件夹；同一个 idempotency_key 不会重复发送。"
	};
}
/**
* `rename` — rename one asset.
*
* The name is sent verbatim unless the caller names an `episode` and
* `asset_category`, in which case this composes the conventional name exactly as
* `image_generate` does. Nothing renames anything automatically: a rename is a
* change to a name a person may already be reading in the console, so it only
* happens when a caller asks for it.
* @param client - Jubian transport.
* @param ledger - Write-path ledger.
* @param args - `material_id`, `asset_name`, an optional `episode`/`asset_category` pair, and a key.
* @param deps - Optional naming choices.
* @returns The rename's outcome and the name that was sent.
* @throws {JubianError} `INVALID_ARGUMENT` for a missing or unusable argument.
*/
async function renameMethod(client, ledger, args, deps = {}) {
	const key = requireKey(args.idempotency_key);
	const recorded = await replayed(ledger, key);
	if (recorded !== null) return recorded;
	const materialId = need(args.material_id, "material_id");
	if (!Number.isSafeInteger(materialId) || materialId < 1) throw new JubianError("INVALID_ARGUMENT", "material_id");
	const name = args.episode === void 0 ? need(args.asset_name, "asset_name").trim() : composedAssetName(args.episode, need(args.asset_category, "asset_category"), need(args.asset_name, "asset_name"), deps.naming ?? resolveNaming());
	if (!name) throw new JubianError("INVALID_ARGUMENT", "asset_name");
	return {
		...await writeUnderLedger(ledger, key, "asset_rename", () => ({
			id: materialId,
			assetName: name
		}), (sent) => client.request({
			method: "PUT",
			path: "/aigc/material/reName",
			body: need(sent)
		})),
		sent: true,
		status: "renamed",
		material_id: materialId,
		asset_name: name,
		next: "改名已被提供方受理。它只改显示名称，不改图片、不改 id，也不会把资产搬到别的类别；要换类别需要重新生成资产。用 jubian_organize 重读索引确认。"
	};
}
//#endregion
//#region lib/types/reference.js
/**
* Local reference-image upload: read a file, align it, and put it where the
* workbench puts its own references.
*
* `gpt-image-2` accepts references as HTTPS URLs only, and the URL that works is
* one the provider's own bucket serves. The destination is therefore read from
* the public frontend bundle at call time rather than stored, and the upload is
* signed with the object-storage scheme that bundle uses.
*
* Alignment is the one step this package cannot do itself: both edges must be
* multiples of 16, and Node ships no image codec while this package adds no
* runtime dependency. An already-aligned file is uploaded byte for byte; an
* unaligned one is handed to the local `ffmpeg` binary when one can be found,
* and otherwise the call fails with the exact size the caller must produce. It
* never uploads an unaligned file silently — that would be a different request
* from the one the provider's own client makes.
*/
const run = promisify(execFile);
/** The workbench origin whose bundle carries the upload destination. */
const FRONTEND_URL = "https://web.jubianai.net/";
/** Where a local `ffmpeg` may be found, in resolution order. */
const FFMPEG_ENV = [
	"DSH_JUBIAN_FFMPEG",
	"FFMPEG_PATH",
	"MUSE_FFMPEG_EXECUTABLE"
];
/** The file extension one detected container format uses. */
const EXTENSIONS = {
	jpeg: ".jpg",
	png: ".png",
	webp: ".webp"
};
function fail$1(code = "CONTRACT_CHANGED") {
	throw new JubianError(code);
}
/** Resolve the `ffmpeg` binary this call will use, or null when none is configured. */
function ffmpegBinary(explicit) {
	if (explicit !== void 0 && explicit.trim()) return explicit;
	for (const name of FFMPEG_ENV) {
		const value = process.env[name];
		if (value !== void 0 && value.trim()) return value;
	}
	return "ffmpeg";
}
/**
* Re-encode one image to the required size with a local `ffmpeg`.
*
* The scale filter is the only transformation: the provider's rule is about the
* frame's edges, not about its content, and re-encoding at all is what makes the
* new size true of the pixels rather than only of a header.
* @param request - Source bytes, detected format and target size.
* @param explicitPath - Configured binary path, or undefined to use the environment.
* @returns The normalized file's bytes, in the source's own container format.
* @throws {JubianError} `CONTRACT_CHANGED` when no usable `ffmpeg` produced a readable result.
*/
async function scaleImageWithFfmpeg(request, explicitPath) {
	const directory = await mkdtemp(join(tmpdir(), "jubian-reference-"));
	const extension = EXTENSIONS[request.format];
	const source = join(directory, `source${extension}`);
	const target = join(directory, `prepared${extension}`);
	try {
		await writeFile(source, request.bytes);
		try {
			await run(ffmpegBinary(explicitPath), [
				"-y",
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				source,
				"-vf",
				`scale=${request.target.width}:${request.target.height}`,
				"-frames:v",
				"1",
				target
			], {
				windowsHide: true,
				maxBuffer: 4 * 1024 * 1024
			});
		} catch {
			return fail$1();
		}
		const bytes = await readFile(target);
		const normalized = readReferenceImage(bytes);
		if (normalized.width !== request.target.width || normalized.height !== request.target.height) return fail$1();
		return bytes;
	} finally {
		await rm(directory, {
			recursive: true,
			force: true
		});
	}
}
/** Read the upload destination from the live frontend bundle. */
async function loadTosConfig(transport) {
	let html;
	let appJs;
	try {
		const page = await transport(FRONTEND_URL, { redirect: "follow" });
		if (!page.ok) return fail$1("NETWORK_ERROR");
		html = await page.text();
		const script = await transport(extractAppScriptUrl(html, FRONTEND_URL), { redirect: "follow" });
		if (!script.ok) return fail$1("NETWORK_ERROR");
		appJs = await script.text();
	} catch (error) {
		if (error instanceof JubianError) throw error;
		return fail$1("NETWORK_ERROR");
	}
	return extractTosUploadConfig(appJs);
}
/** Copy bytes into a plain `ArrayBuffer`-backed view, the shape a fetch body accepts. */
function asBody(bytes) {
	const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
	copy.set(bytes);
	return copy;
}
/** Put one object and confirm the provider accepted it. */
async function putObject(transport, url, headers, payload) {
	let response;
	try {
		response = await transport(url, {
			method: "PUT",
			headers,
			body: asBody(payload)
		});
	} catch {
		return fail$1("NETWORK_ERROR");
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => void 0);
		return fail$1("NETWORK_ERROR");
	}
}
/** The refusal a caller gets when an unaligned image cannot be re-encoded locally. */
function alignmentRefusal(image, size) {
	return {
		uploaded: false,
		status: "alignment_required",
		source_width: image.width,
		source_height: image.height,
		required_width: size.width,
		required_height: size.height,
		guidance: `参考图 ${image.width}×${image.height} 的两条边必须是 16 的倍数（应为 ${size.width}×${size.height}）。本机找不到可用的 ffmpeg，插件不会把不合规的图片上传上去。请先把文件改成 ${size.width}×${size.height}（例如 ffmpeg -i in -vf scale=${size.width}:${size.height} out），或把 DSH_JUBIAN_FFMPEG 指向 ffmpeg 可执行文件（也可用 FFMPEG_PATH）后重试。`
	};
}
/**
* Upload one local reference image and return the material item that names it.
*
* The returned `material_url` is what an asset request's `materialList` or a
* generation's `references` must use. The call is free and creates no task, but
* it does write one object into the provider's bucket, so a caller that only
* needs a URL it already has should not call it.
* @param args - `image_path`, the local file to upload.
* @param deps - Optional transport, re-encode, clock and `ffmpeg` path overrides.
* @returns The uploaded URL and its material item, or an `alignment_required` refusal.
* @throws {JubianError} `CONTRACT_CHANGED` when the file, its format or the bundle layout cannot be used,
*   or `NETWORK_ERROR` when the frontend or the bucket could not be reached.
*/
async function uploadReferenceMethod(args, deps = {}) {
	const path = args.image_path;
	if (path === void 0 || !path.trim()) fail$1();
	const source = resolve(path);
	let bytes;
	try {
		bytes = await readFile(source);
	} catch {
		return fail$1();
	}
	const image = readReferenceImage(bytes);
	const size = alignedReferenceSize(image);
	const transport = deps.fetch ?? fetch;
	const now = deps.now?.() ?? /* @__PURE__ */ new Date();
	let payload = bytes;
	if (!size.aligned) {
		const scaler = deps.scaleImage ?? (async (request) => await scaleImageWithFfmpeg(request, deps.ffmpegPath));
		try {
			payload = await scaler({
				bytes,
				width: image.width,
				height: image.height,
				format: image.format,
				target: {
					width: size.width,
					height: size.height
				}
			});
		} catch {
			return alignmentRefusal(image, size);
		}
	}
	const key = buildReferenceObjectKey(now, randomBytes(16).toString("hex"), image.extension);
	const signed = signTosObjectPut({
		config: await loadTosConfig(transport),
		key,
		payload,
		content_type: image.content_type,
		now
	});
	await putObject(transport, signed.url, signed.headers, payload);
	return {
		...referenceMaterialItem(signed.url, 1),
		format: image.format,
		source_width: image.width,
		source_height: image.height,
		width: size.width,
		height: size.height,
		reencoded: !size.aligned,
		bytes: payload.byteLength,
		sha256: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
		next: "把这个 material_url 作为 gpt-image-2 的参考图 URL 使用（image_generate 的 references），或放进资产的 materialList。上传本身免费、不创建任务。"
	};
}
//#endregion
//#region lib/types/methods.js
/**
* Every Jubian tool method, as a plain async function over an injected client.
*
* Write methods run under the ledger and require the caller's `idempotency_key`:
* a key that already has a record returns that record instead of sending a
* second paid request, which is the only honest answer to "did that timeout
* already charge me?".
*
* Read methods never touch the ledger. Three of them are worth naming here
* because their HTTP verbs lie: `subtasks` is a POST that only reads,
* `confirm_casting` is a GET that changes provider state, and `prepare_video`
* writes only a local preview file while reading everything it needs.
*/
/** Provider statuses that mean a task is still moving and a retry would race it. */
const ACTIVE_STATUSES = [
	"submit",
	"submitted",
	"pending",
	"queued",
	"running",
	"processing"
];
/** Default readback budget: a measured image asset reaches `Active` in one to two minutes. */
const IMAGE_ACTIVE_TIMEOUT_MS = 18e4;
/** Default readback poll interval. */
const IMAGE_ACTIVE_POLL_MS = 3e3;
/** One readback with nothing read and one reason why. */
function unread(status, error) {
	return {
		status,
		material_id: null,
		image_url: null,
		observed_status: null,
		waited_ms: 0,
		error
	};
}
/**
* The one instruction that matches what the readback actually established.
* @param readback - The readback outcome.
* @returns Caller-facing guidance naming the only safe next action.
*/
function imageNext(readback) {
	switch (readback.status) {
		case "active": return "资产已 Active：material_id 是可用于 confirm_casting 的生成材质 ID，image_url 是这张生成图。此时再落盘或审核，才不会拿到一个空资产。";
		case "failed": return "资产已被提供方判为失败，不会再有生成图；重新生成要换一个新的 idempotency_key，同一个 key 不会再次发送。";
		case "timeout": return "受理已计费（outcome=accepted）但回读超时：不要换 key 重投，用 jubian_asset get 读 parent_asset_id 的状态，Active 之后再用 generated_image 取图。";
		case "replayed": return "本次是重放：没有发送任何请求。资产身份请用 jubian_asset list/get 回读。";
		case "unverified": return "没有确认资产与生成图：先回读 jubian_asset list 核对，确认前不要落盘，也不要换 key 重投。";
	}
}
/**
* Wait for the accepted asset to become `Active`, then read its generated image.
*
* `POST /aigc/asset` is asynchronous: the response carries the new asset id, and
* the asset has no image until the provider's own pipeline finishes. Returning at
* acceptance would hand the caller an asset that reads back empty, so this polls
* the free asset read until `hsAssetStatus` is `Active` and then reads the one
* endpoint that carries both the material id and the image URL.
* @param client - Jubian transport.
* @param assetId - The asset id the accepted response carried, or null when it carried none.
* @param options - Readback budget, poll interval, clock and sleep.
* @returns The readback outcome; a timed-out readback is reported, never thrown, because the
*   paid write was already accepted and the ledger already records it.
*/
async function awaitGeneratedImage(client, assetId, options) {
	if (assetId === null) return unread("unverified", "受理响应没有给出可回读的资产 ID，无法确认生成图；用 jubian_asset list 按 asset_name 找到该资产后再读 generated_image。");
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
		setTimeout(resolve, ms);
	}));
	const budget = options.activeTimeoutMs ?? IMAGE_ACTIVE_TIMEOUT_MS;
	const interval = options.pollIntervalMs ?? IMAGE_ACTIVE_POLL_MS;
	const started = now();
	let observed = null;
	let lastError = null;
	for (;;) {
		observed = readAssetPage((await client.request({
			method: "GET",
			path: `/aigc/asset/${assetId}`
		})).data).status;
		if (observed !== null && observed.trim().toLowerCase() === "active") try {
			const image = readGeneratedImage((await client.request({
				method: "GET",
				path: `/aigc/material/getGeneratedImageByAssetId?assetId=${assetId}`
			})).data);
			return {
				status: "active",
				material_id: image.material_id,
				image_url: image.url,
				observed_status: observed,
				waited_ms: now() - started,
				error: null
			};
		} catch (error) {
			if (!(error instanceof JubianError) || error.code !== "CONTRACT_CHANGED") throw error;
			lastError = error.message;
		}
		else if (observed !== null && FAILED_STATUSES.includes(observed.trim().toLowerCase())) return {
			status: "failed",
			material_id: null,
			image_url: null,
			observed_status: observed,
			waited_ms: now() - started,
			error: `资产状态为 ${observed}，不会再有生成图。`
		};
		const elapsed = now() - started;
		if (elapsed + interval > budget) return {
			status: "timeout",
			material_id: null,
			image_url: null,
			observed_status: observed,
			waited_ms: elapsed,
			error: `回读超时：资产在 ${budget}ms 内没有变为 Active（最后观察到的状态：${observed ?? "未提供"}${lastError === null ? "" : `；生成图读取失败：${lastError}`}）。受理已被计费，不要换 key 重投。`
		};
		await sleep(interval);
	}
}
/**
* Compose the sortable prefix a processing stage puts in front of the source
* task's own name.
* @param args - The dispatched arguments, read for `episode` and `package_number`.
* @param naming - Resolved naming choices, or undefined for their defaults.
* @returns `EP05-P3-`, or an empty string when the caller named no episode.
*/
function stagePrefix(args, naming) {
	if (args.episode === void 0) return "";
	return `${taskPrefix(args.episode, args.package_number, naming ?? resolveNaming())}-`;
}
function page(args) {
	const num = args.page_num ?? 1;
	const size = args.page_size ?? 20;
	if (!Number.isSafeInteger(num) || num < 1 || !Number.isSafeInteger(size) || size < 1 || size > 1e3) throw new JubianError("CONTRACT_CHANGED");
	return `pageNum=${num}&pageSize=${size}`;
}
/**
* `jubian_catalog` — catalogue, screenplay and episode reads.
* @param client - Jubian transport.
* @param args - Dispatched on `method`.
* @returns The requested slice, keyed by the `method` that asked for it.
*/
async function catalogMethod(client, args) {
	switch (args.method) {
		case "models": {
			const taskType = need(args.task_type);
			if (![
				MODEL_TASK_TYPES.video,
				MODEL_TASK_TYPES.image,
				MODEL_TASK_TYPES.subtitleErasure
			].includes(taskType)) throw new JubianError("CONTRACT_CHANGED");
			return { models: readModels((await client.request({
				method: "GET",
				path: `/model/charge/getSelectList?taskType=${taskType}`
			})).data) };
		}
		case "rate": {
			const standardId = need(args.standard_id);
			return { rate: (await client.request({
				method: "GET",
				path: `/model/charge/${standardId}`
			})).data };
		}
		case "script": return { script: readScript((await client.request({
			method: "GET",
			path: `/aigc/script/${need(args.script_id)}`
		})).data) };
		case "episodes": {
			const scriptId = need(args.script_id);
			return { episodes: readEpisodes((await client.request({
				method: "GET",
				path: `/aigc/episode/list?scriptId=${scriptId}&${page(args)}`
			})).data) };
		}
		default: throw new JubianError("CONTRACT_CHANGED");
	}
}
/**
* Every asset the provider lists for one project, as identity plus declared category.
* @param client - Jubian transport.
* @param scriptId - The project to list.
* @returns One entry per listed asset.
*/
async function listedAssets(client, scriptId) {
	return readAssetList((await client.request({
		method: "GET",
		path: `/aigc/asset/list?scriptId=${scriptId}&pageNum=1&pageSize=1000`
	})).data).rows.map((row) => ({
		asset_id: row.asset_id,
		asset_type: row.asset_type
	}));
}
/**
* `jubian_asset` — asset and material reads, the state-changing casting
* confirmation, the irreversible removal, the explicit-category registration
* and the local reference upload.
* @param client - Jubian transport.
* @param ledger - Write-path ledger, used only by the two state-changing methods.
* @param args - Dispatched on `method`.
* @param deps - Optional seams for the local reference upload.
* @returns The requested asset view, keyed by the `method` that asked for it.
*/
async function assetMethod(client, ledger, args, deps = {}) {
	switch (args.method) {
		case "get": return { asset: readAssetPage((await client.request({
			method: "GET",
			path: `/aigc/asset/${need(args.asset_id)}`
		})).data) };
		case "list": {
			const scriptId = need(args.script_id);
			return { assets: readAssetList((await client.request({
				method: "GET",
				path: `/aigc/asset/list?scriptId=${scriptId}&${page(args)}`
			})).data) };
		}
		case "materials": {
			const scriptId = need(args.script_id);
			return { materials: readMaterialList((await client.request({
				method: "GET",
				path: `/aigc/material/list?scriptId=${scriptId}&isUsed=1&pageNum=1&pageSize=1000`
			})).data) };
		}
		case "generated_image": {
			const assetId = need(args.asset_id);
			return { image: readGeneratedImage((await client.request({
				method: "GET",
				path: `/aigc/material/getGeneratedImageByAssetId?assetId=${assetId}`
			})).data) };
		}
		case "confirm_casting": {
			requireKey(args.idempotency_key);
			const materialId = need(args.material_id);
			return { ...await writeUnderLedger(ledger, args.idempotency_key, "confirm_casting", () => void 0, () => client.request({
				method: "GET",
				path: `/aigc/material/confirm/${materialId}`
			})) };
		}
		case "remove": {
			requireKey(args.idempotency_key);
			const assetId = need(args.asset_id);
			const scriptId = need(args.script_id);
			return {
				...await writeUnderLedger(ledger, args.idempotency_key, "asset_remove", () => void 0, () => client.request({
					method: "DELETE",
					path: `/aigc/asset/removeAsset/${assetId}?scriptId=${scriptId}&isParent=1`
				})),
				next: "删除不可恢复：该父资产及其媒体版本已被移除，引用它的镜头匹配与已生成视频不会因此重建。如果只是想取消\"正式选用\"，那不该调用它。"
			};
		}
		case "register": {
			requireKey(args.idempotency_key);
			const scriptId = need(args.script_id);
			const assetName = need(args.asset_name);
			const assetType = need(args.asset_type);
			const assetUrl = need(args.asset_url);
			if (assetType !== 1 && assetType !== 2 && assetType !== 3) throw new JubianError("INVALID_ARGUMENT", "asset_type 必须是 1（角色）、2（场景）或 3（道具）");
			const before = await listedAssets(client, scriptId);
			const result = await writeUnderLedger(ledger, args.idempotency_key, "asset_register", () => ({
				scriptId,
				assetName,
				assetType,
				isLocal: 1,
				url: assetUrl
			}), (payload) => client.request({
				method: "POST",
				path: "/aigc/asset",
				body: need(payload)
			}));
			if (result.replayed) return {
				...result,
				created_asset_id: null,
				new_asset_ids: [],
				next: "同一个 idempotency_key 已经登记过，没有重发。用 jubian_asset list 按名字核对那条资产的类别。"
			};
			const created = (await listedAssets(client, scriptId)).filter((asset) => !before.some((seen) => seen.asset_id === asset.asset_id) && asset.asset_type === assetType);
			return {
				...result,
				created_asset_id: created.length === 1 ? created[0]?.asset_id ?? null : null,
				new_asset_ids: created.map((asset) => asset.asset_id),
				next: created.length === 1 ? "新资产已登记：它引用你给的图片地址，没有触发生成。费用与状态以账户账单为准，不要仅凭本结果断言免费。让它进入主体设定还需要一步确认（jubian_asset confirm_casting 要的是生成材质 ID）。" : "登记请求已受理，但列表里无法唯一确定新资产：用 jubian_asset list 按名字人工核对类别。"
			};
		}
		case "upload_reference": return await uploadReferenceMethod({ image_path: args.image_path }, deps.reference);
		case "create_folder": return await createFolderMethod(client, ledger, args);
		case "move": return await moveMethod(client, ledger, args);
		case "rename": return await renameMethod(client, ledger, args, deps);
		default: throw new JubianError("CONTRACT_CHANGED");
	}
}
/**
* `jubian_video` — video task reads, the paid image generation and the upscale.
* @param client - Jubian transport.
* @param ledger - Write-path ledger, used by every state-changing method here.
* @param args - Dispatched on `method`.
* @param deps - Optional seams for the paid image path: the pinned catalogue row and the readback budget.
* @returns The requested video view, keyed by the `method` that asked for it.
*/
async function videoMethod(client, ledger, args, deps = {}) {
	switch (args.method) {
		case "unresolved": {
			const records = await ledger.unresolved(args.script_id);
			return {
				unresolved: records.map((record) => ({
					record_id: record.record_id,
					idempotency_key: record.idempotency_key,
					method: record.method,
					script_id: record.script_id,
					at: record.at,
					outcome: record.outcome ?? "unsettled"
				})),
				next: records.length === 0 ? "账本里没有未完成的写入：没有需要重新对账的收费调用。" : `有 ${String(records.length)} 笔写入没有确定结果。对账方式按 method 区分：storyboard_native_submit 用同一个 idempotency_key 再调一次 submit_video（只重新对账，不会再发 PUT）；storyboard_generate 用 jubian_storyboard get 回读该分镜的 isGenerate；image_generate 用 jubian_asset list/get 回读资产；erase_subtitle 与 video_upscale 用 jubian_video subtasks 回读该任务。**任何情况下都不要换 key 重发**：没有远端证据就保持未知。`
			};
		}
		case "task": return { task: readTaskPage((await client.request({
			method: "GET",
			path: `/admin/aigc/video/task/${need(args.task_id)}`
		})).data) };
		case "tasks": {
			const scriptId = need(args.script_id);
			const num = args.page_num ?? 1;
			return { tasks: readTaskList((await client.request({
				method: "GET",
				path: `/admin/aigc/video/task/list?scriptId=${scriptId}&taskType=1&pageNum=${num}`
			})).data) };
		}
		case "subtasks": {
			const page = readSubtaskPage((await client.request({
				method: "POST",
				path: "/admin/aigc/video/task/sub/list",
				body: { aigcVideoTaskId: need(args.task_id) }
			})).data);
			const target = args.delivery_resolution;
			return {
				subtasks: {
					...page,
					rows: page.rows.map((row) => ({
						...row,
						needs_upscale: target === void 0 ? null : needsUpscale(row, target),
						delivery_resolution: target ?? null
					}))
				},
				guidance: (target === void 0 ? "未指定 delivery_resolution：无法判断哪些结果低于交付分辨率。" : `交付分辨率 ${target}。`) + "needs_upscale=true 仅提示实际分辨率低于交付尺寸，不是内容不可用判定，也不构成付费义务。SD2.5 默认使用原片，不自动提交或等待高清；任何模型都不能仅因 needs_upscale=true 自动付费。仅在用户明确要求或授权具体高清处理时调用 upscale（包括 SD2.5）。普通导出尺寸与真实源分辨率须分别如实报告；本地缩放不等于恢复源画质。已授权提交的去字幕与转高清都是异步任务，提交后先做别的，稍后再查。"
			};
		}
		case "image_generate": {
			requireKey(args.idempotency_key);
			const selection = deps.image?.selection ?? {};
			const naming = deps.naming ?? resolveNaming();
			const assetCategory = args.asset_category;
			const derivedType = assetCategory === void 0 ? void 0 : ASSET_CATEGORY_TYPES[assetCategory];
			if (assetCategory !== void 0 && args.asset_type !== void 0 && args.asset_type !== derivedType) throw new JubianError("INVALID_ARGUMENT", `asset_type=${args.asset_type} 与 asset_category=${assetCategory}（应为 ${derivedType}）不一致`);
			const assetType = derivedType ?? need(args.asset_type, "asset_type 或 asset_category");
			const assetName = args.episode === void 0 ? need(args.asset_name) : composedAssetName(args.episode, need(assetCategory, "asset_category"), need(args.asset_name), naming);
			let cached;
			const catalogue = async () => {
				cached ??= await client.request({
					method: "GET",
					path: `/model/charge/getSelectList?taskType=${MODEL_TASK_TYPES.image}`
				});
				return cached.data;
			};
			let selectors;
			const result = await writeUnderLedger(ledger, args.idempotency_key, "image_generate", async () => {
				const rows = await catalogue();
				selectors = resolveImageModel(rows, selection);
				return buildImageRequest({
					scriptId: need(args.script_id),
					assetName,
					assetType,
					prompt: need(args.prompt),
					references: args.references ?? [],
					...args.parent_asset_id === void 0 ? {} : { parentAssetId: args.parent_asset_id }
				}, rows, selection);
			}, (body) => client.request({
				method: args.parent_asset_id === void 0 ? "POST" : "PUT",
				path: "/aigc/asset",
				body: need(body)
			}), () => {
				const price = readImageDisplayPrice(cached?.data, selection);
				return {
					...price.status === "available" ? { amount: String(price.unit_price) } : {},
					observedAt: (/* @__PURE__ */ new Date()).toISOString()
				};
			}, { scriptId: need(args.script_id) });
			const assetId = result.data === null || result.data === void 0 || !Number.isSafeInteger(Number(result.data)) ? null : Number(result.data);
			const readback = result.replayed ? unread("replayed", "这个 idempotency_key 已有记录：本次没有发送请求，也没有回读资产。用 jubian_asset get/list 读取该资产，再用 generated_image 确认生成图。") : result.outcome === "accepted" ? await awaitGeneratedImage(client, assetId, deps.image ?? {}) : unread("unverified", "受理结果不是 accepted，无法确认资产是否真的创建；先回读 jubian_asset list，不要换 key 重投。");
			return {
				replayed: result.replayed,
				outcome: result.outcome,
				response_sha256: result.response_sha256,
				parent_asset_id: assetId,
				resolution: selectors?.resolution ?? "",
				model_selection: selectors === void 0 ? null : {
					standard_id: selectors.standardId,
					platform_id: selectors.platformId
				},
				asset_status: readback.status,
				material_id: readback.material_id,
				image_url: readback.image_url,
				observed_asset_status: readback.observed_status,
				waited_ms: readback.waited_ms,
				readback_error: readback.error,
				next: imageNext(readback)
			};
		}
		case "upscale": {
			requireKey(args.idempotency_key);
			const taskId = need(args.task_id);
			let projectId;
			const result = await writeUnderLedger(ledger, args.idempotency_key, "video_upscale", async () => {
				const task = readTaskPage((await client.request({
					method: "GET",
					path: `/admin/aigc/video/task/${taskId}`
				})).data);
				const page = readSubtaskPage((await client.request({
					method: "POST",
					path: "/admin/aigc/video/task/sub/list",
					body: { aigcVideoTaskId: taskId }
				})).data);
				const source = page.rows.find((row) => row.video_url !== null) ?? page.rows[0];
				if (source === void 0) throw new JubianError("CONTRACT_CHANGED");
				const baseUrl = source.base_video_url ?? source.video_url;
				if (baseUrl === null) throw new JubianError("CONTRACT_CHANGED");
				if (source.duration_seconds === null) throw new JubianError("CONTRACT_CHANGED");
				projectId = need(task.script_id ?? args.script_id, "script_id");
				return buildVideoUpscaleRequest({
					scriptId: projectId,
					episodeId: need(task.episode_id ?? void 0),
					episodeCount: task.episode_count ?? 1,
					firstResultId: need(source.first_result_id ?? source.subtask_id),
					parentResultId: source.parent_result_id ?? source.first_result_id ?? source.subtask_id,
					duration: source.duration_seconds,
					videoUrl: baseUrl,
					taskName: args.task_name ?? `${stagePrefix(args, deps.naming)}${task.task_name ?? `task-${taskId}`}-高清转换`
				});
			}, (sent) => client.request({
				method: "POST",
				path: "/aigc/storyboard/hdConversion",
				body: need(sent)
			}), () => projectId === void 0 ? void 0 : { scriptId: projectId });
			return {
				...result,
				accepted_task_id: result.data === void 0 ? null : readUpscaleTaskId({ data: result.data }),
				next: "转高清是异步任务，会持续数分钟到十几分钟。不要在这里等待——先做别的，之后再用 subtasks 回读该任务的 hd_count / last_task_type / resolution 判断是否转好。"
			};
		}
		case "retry": {
			requireKey(args.idempotency_key);
			const taskId = need(args.task_id);
			return {
				...await writeUnderLedger(ledger, args.idempotency_key, "video_task_retry", async () => {
					const task = readTaskPage((await client.request({
						method: "GET",
						path: `/admin/aigc/video/task/${taskId}`
					})).data);
					const page = readSubtaskPage((await client.request({
						method: "POST",
						path: "/admin/aigc/video/task/sub/list",
						body: { aigcVideoTaskId: taskId }
					})).data);
					const status = (task.status ?? "").trim().toLowerCase();
					const terminalFailure = FAILED_STATUSES.includes(status);
					const settledChild = page.rows.some((row) => row.video_url !== null || [...SUCCESS_STATUSES, ...ACTIVE_STATUSES].includes((row.status ?? "").trim().toLowerCase()));
					const charged = task.real_cost !== null && task.real_cost !== "0" && task.real_cost !== "0.0";
					if (!terminalFailure || settledChild || charged) throw new JubianError("CONTRACT_CHANGED");
				}, () => client.request({
					method: "POST",
					path: `/admin/aigc/video/task/retry/${taskId}`
				})),
				next: "重试是服务端状态变更：只在父子任务都已终止失败、没有结果 URL、也没有真实费用时才会发出。重试响应异常时不要盲目重提——先回读父任务与生成子素材：子素材已有成功 URL 就按成功处理，子素材仍在活动就继续等待，不删除、不创建替代任务。"
			};
		}
		default: throw new JubianError("CONTRACT_CHANGED");
	}
}
/**
* `jubian_storyboard` — storyboard reads, the free saves, the paid generation,
* the erasure and the storyboard-native video channel.
*
* `save` and `generate` both work by reading the provider's own snapshot and
* changing exactly one field, so every field the provider owns survives the
* round trip and a caller never composes a full storyboard body.
* @param client - Jubian transport.
* @param ledger - Write-path ledger.
* @param args - Dispatched on `method`.
* @param deps - Optional seams; the naming convention drives the `erase_subtitle` task name.
* @returns The requested storyboard view, keyed by the `method` that asked for it.
*/
async function storyboardMethod(client, ledger, args, deps = {}) {
	const storyboardId = () => need(args.storyboard_id);
	switch (args.method) {
		case "get": return { storyboard: readStoryboard((await client.request({
			method: "GET",
			path: `/aigc/storyboard/${storyboardId()}`
		})).data, storyboardId()) };
		case "create": {
			requireKey(args.idempotency_key);
			if (args.body !== void 0 && args.body_path !== void 0) throw new JubianError("INVALID_ARGUMENT");
			let body = args.body;
			if (args.body_path !== void 0) {
				let parsed;
				try {
					parsed = JSON.parse(await readFile(resolve(args.body_path), "utf8"));
				} catch {
					throw new JubianError("INVALID_ARGUMENT");
				}
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new JubianError("INVALID_ARGUMENT");
				body = parsed;
			}
			return { ...await writeUnderLedger(ledger, args.idempotency_key, "storyboard_create", () => ({
				...need(body),
				isGenerate: 0
			}), (sent) => client.request({
				method: "POST",
				path: "/aigc/storyboard",
				body: need(sent)
			})) };
		}
		case "save":
			requireKey(args.idempotency_key);
			return { ...await writeUnderLedger(ledger, args.idempotency_key, "storyboard_save", () => void 0, async () => {
				const current = await client.request({
					method: "GET",
					path: `/aigc/storyboard/${storyboardId()}`
				});
				return client.request({
					method: "PUT",
					path: "/aigc/storyboard",
					body: withGenerationDisabled(current.data)
				});
			}) };
		case "generate": {
			requireKey(args.idempotency_key);
			let projectId;
			return { ...await writeUnderLedger(ledger, args.idempotency_key, "storyboard_generate", async () => {
				const current = await client.request({
					method: "GET",
					path: `/aigc/storyboard/${storyboardId()}`
				});
				projectId = positiveInteger(current.data?.scriptId);
				return withGenerationEnabled(current.data, need(args.content_duration_ms));
			}, (body) => client.request({
				method: "PUT",
				path: "/aigc/storyboard",
				body: need(body)
			}), () => projectId === void 0 ? void 0 : { scriptId: projectId }) };
		}
		case "select_assets":
			requireKey(args.idempotency_key);
			return await selectAssetsMethod(client, ledger, {
				storyboard_id: args.storyboard_id,
				selections: args.selections,
				idempotency_key: args.idempotency_key
			});
		case "prepare_video": return await prepareVideoMethod(client, {
			storyboard_id: args.storyboard_id,
			project_dir: args.project_dir,
			content_duration_ms: args.content_duration_ms
		});
		case "submit_video":
			requireKey(args.idempotency_key);
			return await submitVideoMethod(client, ledger, {
				preview_path: args.preview_path,
				project_dir: args.project_dir,
				storyboard_id: args.storyboard_id,
				idempotency_key: args.idempotency_key
			});
		case "erase_subtitle": {
			requireKey(args.idempotency_key);
			const taskId = need(args.task_id);
			let projectId;
			const result = await writeUnderLedger(ledger, args.idempotency_key, "erase_subtitle", async () => {
				const task = readTaskPage((await client.request({
					method: "GET",
					path: `/admin/aigc/video/task/${taskId}`
				})).data);
				const page = readSubtaskPage((await client.request({
					method: "POST",
					path: "/admin/aigc/video/task/sub/list",
					body: { aigcVideoTaskId: taskId }
				})).data);
				const source = page.rows.find((row) => row.video_url !== null) ?? page.rows[0];
				if (source === void 0) throw new JubianError("CONTRACT_CHANGED");
				const baseUrl = source.base_video_url ?? source.video_url;
				if (baseUrl === null) throw new JubianError("CONTRACT_CHANGED");
				if (source.duration_seconds === null) throw new JubianError("CONTRACT_CHANGED");
				projectId = need(task.script_id ?? args.script_id, "script_id");
				return buildSubtitleEraseRequest(need(args.model_id, "model_id"), {
					scriptId: projectId,
					episodeId: need(task.episode_id ?? void 0),
					episodeCount: task.episode_count ?? 1,
					taskName: args.task_name ?? `${stagePrefix(args, deps.naming)}${task.task_name ?? `task-${taskId}`}-去字幕`,
					firstResultId: need(source.first_result_id ?? source.subtask_id),
					parentResultId: source.parent_result_id ?? source.first_result_id ?? source.subtask_id,
					videoUrl: baseUrl,
					duration: source.duration_seconds,
					videoWidth: need(args.video_width),
					videoHeight: need(args.video_height),
					...args.subtitle_box === void 0 ? {} : { subtitleBox: args.subtitle_box }
				});
			}, (sent) => client.request({
				method: "POST",
				path: "/aigc/storyboard/subtitleEraser",
				body: need(sent)
			}), () => projectId === void 0 ? void 0 : { scriptId: projectId });
			return {
				...result,
				accepted_task_id: readSubtitleTaskId({
					code: 200,
					data: result.data
				}),
				next: "去字幕是异步任务。不要在这里等待——先做别的，之后用 subtasks 回读；只有 subtitle_erased=true 且 video_url 有值才表示当前文件已有成功的去字幕记录。"
			};
		}
		default: throw new JubianError("CONTRACT_CHANGED");
	}
}
/**
* `jubian_media` — download provider media bytes to a local file for inspection.
*
* The bytes never enter a tool result: a result carrying tens of megabytes of
* base64 would poison every later request's context. This method writes the file
* and returns its path, size and digest, and a caller then reads that path with
* its own image or frame-extraction tool.
*
* The write goes through Node's filesystem rather than the harness `fs` service,
* which exposes only `writeText` and has no binary write. Jubian's CDN needs no
* credential, so this sends none.
* @param args - `media_url`, `media_kind` and `output_path` are required.
* @returns The written file's path, kind, media type, byte length and digest.
*/
async function mediaMethod(args) {
	const kind = need(args.media_kind);
	const downloaded = await downloadMedia(need(args.media_url), { kind });
	const target = resolve(need(args.output_path));
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, downloaded.bytes);
	return {
		path: target,
		kind: downloaded.kind,
		media_type: downloaded.media_type,
		bytes: downloaded.bytes.byteLength,
		sha256: downloaded.sha256
	};
}
//#endregion
//#region lib/types/budget-settings.js
/**
* Read the drama namespace's resolved per-series CNY limit at each paid claim.
* An unmounted namespace keeps legacy manual authorization; a malformed mounted
* section fails closed instead of silently falling back to a different cap.
* @param ctx - Host context that may carry the settings service.
* @returns Nonnegative integer cents, or undefined without the drama namespace.
*/
function seriesBudgetLimit(ctx) {
	const settings = ctx.get("settings");
	if (settings === void 0) return void 0;
	const section = settings.get("drama");
	if (section === void 0) return void 0;
	const amount = typeof section === "object" && section !== null && !Array.isArray(section) ? section.seriesBudgetCents : void 0;
	if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new Error("Jubian budget: drama.seriesBudgetCents must be nonnegative safe integer cents");
	return amount;
}
//#endregion
//#region lib/types/image.js
/**
* The paid image route's deployment choices: which `gpt-image-2` catalogue row
* `jubian_video image_generate` buys from, and the read-only Remote face a
* Settings page lists that row's alternatives over.
*
* The row is one fact with two homes, in this order: the short-drama settings
* section, which a person edits on the Web Settings page, and then this row's own
* composition config. The settings document wins because the page is the only
* surface that can show the account's own price next to each candidate; the config
* stays as what a deployment without that page states.
*
* This plugin never picks a row on its own: a catalogue listing several of them
* fails in `resolveImageModel` and names every candidate, because a default would
* spend real money on a platform nobody selected.
*
* @module @deepseek-ai/dsh-tool-jubian/src/image
*/
var __runInitializers$1 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate$1 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* The short-drama settings section that may pin the paid image row, and the field
* inside it. Spelled here rather than imported: the section is read through the
* settings service's generic `get`, so this row keeps working — and keeps its
* dependency list — whether or not the drama settings package is composed.
*/
const DRAMA_IMAGE_SETTING = {
	namespace: "drama",
	field: "imageStandardId"
};
/**
* Read the row the short-drama settings section pinned.
*
* The section is a durable document another package owns, so the field is checked
* rather than trusted: anything but a positive integer is no pin at all, and the
* route then falls back to the composition config exactly as if the field had
* never been written.
* @param ctx - Host context that may carry the settings service.
* @returns the pinned catalogue row id, or undefined while nothing pins one.
*/
function pinnedStandardId(ctx) {
	const settings = ctx.get("settings");
	if (settings === void 0) return void 0;
	const section = settings.get(DRAMA_IMAGE_SETTING.namespace);
	if (typeof section !== "object" || section === null) return void 0;
	const value = section[DRAMA_IMAGE_SETTING.field];
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
/**
* The catalogue row one paid image call buys from, resolved as that call is made.
*
* Resolved per call rather than once at mount: the settings document can change
* while this row stays loaded, and a page edit has to reach the next paid call
* without a restart.
* @param ctx - Host context that may carry the settings service.
* @param config - this row's own composition config.
* @returns the selection `resolveImageModel` receives; an empty one means no row is pinned.
*/
function pinnedImageSelection(ctx, config) {
	const standardId = pinnedStandardId(ctx);
	if (standardId !== void 0) return { standardId };
	return {
		...config.imageStandardId === void 0 ? {} : { standardId: config.imageStandardId },
		...config.imagePlatformId === void 0 ? {} : { platformId: config.imagePlatformId }
	};
}
/**
* Host service backing the generated `ctx.remote.jubianImage` namespace: the rows
* the paid image route may buy from.
*
* The namespace reads and never writes, and it carries rows only — the token that
* authorizes the read never crosses to the browser.
*/
let JubianImageRoutes = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _routes_decorators;
	return class JubianImageRoutes extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_routes_decorators = [Remote];
			__esDecorate$1(this, null, _routes_decorators, {
				kind: "method",
				name: "routes",
				static: false,
				private: false,
				access: {
					has: (obj) => "routes" in obj,
					get: (obj) => obj.routes
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		/**
		* @param ctx - Host context carrying the Remote assembly.
		* @param options - the transport the tools already read the account over.
		*/
		constructor(ctx, options) {
			super(ctx, "jubianImage");
			this.client = options.client;
		}
		/** Transport shared with the tools: one origin, one credential, one timeout. */
		client = __runInitializers$1(this, _instanceExtraInitializers);
		/**
		* List the `gpt-image-2` catalogue rows this account may buy from.
		*
		* Free and read-only: the very catalogue read the paid call makes, spending
		* nothing. A Settings page offers these rows so a person picks a platform by its
		* own price instead of reading that price out of a failure message.
		* @returns one entry per `gpt-image-2` row, in catalogue order.
		* @throws RemoteError when the catalogue cannot be read; its message is what the page shows.
		*/
		async routes() {
			try {
				return { candidates: imageCandidates(readModels((await this.client.request({
					method: "GET",
					path: `/model/charge/getSelectList?taskType=${MODEL_TASK_TYPES.image}`
				})).data)) };
			} catch (error) {
				throw new RemoteError("jubian-image/catalogue-unreadable", error instanceof Error ? error.message : String(error), {}, { cause: error });
			}
		}
	};
})();
//#endregion
//#region lib/types/organize.js
/**
* The read-only organization view over one project's assets.
*
* One call joins three remote reads and the project's own `assets_manifest.json`
* into the listing a person would otherwise assemble by hand: which episode uses
* which character, scene and prop, and what each asset's remote identifiers and
* statuses are. It sends only reads, charges nothing, and reports — never edits —
* the names that do not yet follow the convention.
*
* The local manifest is the episode map because the provider holds no per-asset
* episode field; the remote reads supply the names, identifiers and statuses the
* manifest cannot be trusted to have kept current. A remote asset no manifest row
* names is reported rather than dropped, because that is exactly the asset a
* caller has lost track of.
*/
/** Page size every read asks for: the provider's own documented maximum. */
const PAGE_SIZE = 1e3;
/** Where the index lands inside the project directory unless configured otherwise. */
const DEFAULT_INDEX_PATH = join("_probe", "asset-index.md");
/** Manifest `type` spellings that belong to one category, in either language the pipeline writes. */
const TYPE_ALIASES = {
	character: "角色",
	角色: "角色",
	scene: "场景",
	场景: "场景",
	prop: "道具",
	道具: "道具"
};
/** Read one value as trimmed text, or an empty string when it carries none. */
function text(value) {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}
/** Read one provider or manifest identifier, or null when it is not a positive integer. */
function optionalId(value) {
	const candidate = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
	return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : null;
}
/** Read one manifest row as a plain object. */
function object$1(value, detail) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new JubianError("CONTRACT_CHANGED", detail);
	return value;
}
/**
* Read the project's own asset manifest.
*
* The manifest is a durable-file boundary, so its document, its asset array and
* every row's name, type and episode numbers are validated here: an index built
* over a half-readable manifest would silently report the wrong episodes.
* @param projectDir - Resolved project directory.
* @returns Every declared asset, in manifest order.
* @throws {JubianError} `CONTRACT_CHANGED` when the file, a row or an episode number cannot be read.
*/
async function readManifest(projectDir) {
	const path = join(projectDir, "assets_manifest.json");
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new JubianError("CONTRACT_CHANGED", `${path} 读不到`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch {
		throw new JubianError("CONTRACT_CHANGED", `${path} 不是 JSON`);
	}
	const document = object$1(parsed, `${path} 顶层不是 JSON 对象`);
	const rows = Array.isArray(document.items) ? document.items : document.assets;
	if (!Array.isArray(rows)) throw new JubianError("CONTRACT_CHANGED", `${path} 缺少 items 资产数组`);
	return rows.map((row) => {
		const record = object$1(row, `${path} 有资产行不是对象`);
		const name = text(record.name);
		const category = TYPE_ALIASES[text(record.type).toLowerCase()] ?? null;
		if (!name || category === null) throw new JubianError("CONTRACT_CHANGED", `${path} 有资产缺少 name 或 type`);
		const episodes = [];
		if (Array.isArray(record.episodes)) for (const declared of record.episodes) {
			const episode = text(declared);
			if (!episode) continue;
			const normalized = normalizedEpisode(episode);
			if (normalized === null) throw new JubianError("CONTRACT_CHANGED", `${path} 的 ${name} 集号 ${episode} 不是数字`);
			episodes.push(normalized);
		}
		return {
			name,
			category,
			episodes,
			asset_id: optionalId(record.jubian_asset_id ?? record.asset_id),
			material_id: optionalId(record.jubian_material_id ?? record.material_id),
			official: record.official === true,
			status: text(record.asset_status) || null
		};
	});
}
/**
* Read every page of a project's asset list.
*
* The endpoint pages, and an index that stopped at the first page would report a
* project's assets as a fraction of themselves.
* @param client - Jubian transport.
* @param scriptId - Project to list.
* @returns Every asset row the provider holds for the project.
*/
async function readAllAssets(client, scriptId) {
	const collected = [];
	let pageNum = 1;
	for (;;) {
		const page = readAssetList((await client.request({
			method: "GET",
			path: `/aigc/asset/list?scriptId=${scriptId}&pageNum=${pageNum}&pageSize=${PAGE_SIZE}`
		})).data);
		collected.push(...page.rows);
		if (page.rows.length === 0 || collected.length >= page.total) return collected;
		pageNum += 1;
	}
}
/** One empty category bucket per category the console pages on. */
function emptyBuckets() {
	return {
		角色: [],
		场景: [],
		道具: []
	};
}
/** Audit one remote name, recording a violation when it does not conform. */
function audit(name, source, id, naming, violations) {
	const verdict = auditAssetName(name, naming);
	if (!verdict.conforming) violations.push({
		source,
		id,
		name,
		reason: verdict.reason
	});
	return verdict.conforming;
}
/** Render one markdown table row for an indexed asset. */
function assetRow(asset) {
	return `| ${asset.name} | ${asset.official ? "是" : "否"} | ${asset.asset_id ?? "—"} | ${asset.material_id ?? "—"} | ${asset.remote_name ?? "—"} | ${asset.remote_status ?? asset.manifest_status ?? "—"} |`;
}
/** Render the whole index as markdown, mirroring the value the tool returns. */
function renderMarkdown(index) {
	const episodes = index.episodes;
	const series = index.series;
	const lines = [
		"# 资产组织索引",
		"",
		`- 项目 scriptId：${String(index.script_id)}`,
		`- 素材来源：${String(index.source_manifest)}`,
		`- 命名规范：${String(index.convention)}`,
		""
	];
	const section = (title, categories) => {
		lines.push(`## ${title}`, "");
		for (const category of ASSET_CATEGORIES) {
			const rows = categories[category];
			if (rows.length === 0) continue;
			lines.push(`### ${category}`, "", "| 名称 | 正式 | asset_id | material_id | 远端名 | 状态 |", "|---|---|---|---|---|---|", ...rows.map(assetRow), "");
		}
	};
	for (const episode of episodes) section(`${episode.label}（本集资产 ${String(episode.asset_count)} 项，视频任务 ${String(episode.video_tasks.length)} 个）`, episode.categories);
	section("全剧母版（未标注集号的资产）", series);
	const unmatched = index.unmatched_remote_assets;
	lines.push("## 未匹配的远端资产", "", ...unmatched.length === 0 ? ["（无：每个远端资产都在清单里有对应行）"] : unmatched.map((asset) => `- ${asset.asset_id} ${asset.name ?? "（无名称）"}`), "");
	const violations = index.naming_violations;
	lines.push("## 命名审计", "", `共检查 ${String(index.naming_checked)} 个远端名称，${String(violations.length)} 个不符合规范。`, "", ...violations.length === 0 ? [] : violations.map((item) => `- [${item.source} ${String(item.id)}] ${item.name} —— ${item.reason}`), "");
	const folders = index.folders;
	const flatten = (nodes, depth) => nodes.flatMap((node) => [`${"  ".repeat(depth)}- ${node.name ?? "（无名称）"}（folder_id=${String(node.folder_id)}）`, ...flatten(node.children, depth + 1)]);
	lines.push("## 文件夹", "", `库范围：${String(index.folder_scope)}`, "");
	for (const category of ASSET_CATEGORIES) lines.push(`### ${category}库`, "", ...folders[category].length === 0 ? ["（无文件夹）"] : flatten(folders[category], 0), "");
	const mismatches = index.category_mismatches;
	lines.push("## 类别审计", "", `共 ${String(mismatches.length)} 个资产的类别号与它自己的名字或清单声明不一致。`, "", ...mismatches.length === 0 ? [] : mismatches.map((item) => `- asset ${String(item.asset_id)} ${item.name ?? "（无名称）"}：assetType=${String(item.asset_type)}，应为 ${item.expected}（清单声明 ${item.manifest_category ?? "未登记"}，名字声明 ${item.declared_category ?? "未声明"}）`), "");
	lines.push("> 类别不一致是历史遗留的创建请求写错了 assetType。这里只报告：改类别要重新生成资产，改名要用 jubian_asset rename，都需要用户明确同意后才执行。");
	return `${lines.join("\n")}\n`;
}
/** Write one text file atomically inside its destination directory. */
async function atomicWriteText(path, body) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, body, "utf8");
	await rename(temporary, path);
}
/**
* Build one project's asset index without changing anything remote.
* @param client - Jubian transport.
* @param args - `script_id` and `project_dir` are required.
* @param options - Resolved naming choices and the index path inside the project.
* @returns The episode-by-category index, the naming audit, and the index file's path.
* @throws {JubianError} `INVALID_ARGUMENT` for a missing argument, `CONTRACT_CHANGED` for a manifest
*   that cannot be read or an index path that would leave the project directory.
*/
async function organizeMethod(client, args, options) {
	const scriptId = need(args.script_id, "script_id");
	const projectRoot = resolve(need(args.project_dir, "project_dir"));
	const manifest = await readManifest(projectRoot);
	const assets = await readAllAssets(client, scriptId);
	const materials = readMaterialList((await client.request({
		method: "GET",
		path: `/aigc/material/list?scriptId=${scriptId}&isUsed=1&pageNum=1&pageSize=${PAGE_SIZE}`
	})).data);
	const tasks = readTaskList((await client.request({
		method: "GET",
		path: `/admin/aigc/video/task/list?scriptId=${scriptId}&taskType=1&pageNum=1`
	})).data);
	const assetById = new Map(assets.map((row) => [row.asset_id, row]));
	const materialByAssetId = /* @__PURE__ */ new Map();
	for (const row of materials.rows) if (row.asset_id !== null) materialByAssetId.set(row.asset_id, row);
	const buckets = /* @__PURE__ */ new Map();
	const series = emptyBuckets();
	const matched = /* @__PURE__ */ new Set();
	const manifestByAssetId = /* @__PURE__ */ new Map();
	for (const item of manifest) {
		const remote = item.asset_id === null ? void 0 : assetById.get(item.asset_id);
		const material = item.asset_id === null ? void 0 : materialByAssetId.get(item.asset_id);
		if (item.asset_id !== null) {
			matched.add(item.asset_id);
			manifestByAssetId.set(item.asset_id, item);
		}
		const entry = {
			name: item.name,
			official: item.official,
			asset_id: item.asset_id,
			material_id: item.material_id ?? material?.material_id ?? null,
			manifest_status: item.status,
			remote_name: remote?.name ?? null,
			remote_status: material?.status ?? null
		};
		if (item.episodes.length === 0) {
			series[item.category].push(entry);
			continue;
		}
		for (const episode of item.episodes) {
			const bucket = buckets.get(episode) ?? emptyBuckets();
			bucket[item.category].push(entry);
			buckets.set(episode, bucket);
		}
	}
	const violations = [];
	let checked = 0;
	for (const row of assets) {
		if (row.name === null) continue;
		checked += 1;
		audit(row.name, "asset", row.asset_id, options.naming, violations);
	}
	for (const row of materials.rows) {
		if (row.name === null) continue;
		checked += 1;
		audit(row.name, "material", row.material_id, options.naming, violations);
	}
	const mismatches = [];
	for (const row of assets) {
		const remoteType = categoryOfType(row.asset_type);
		if (remoteType === null) continue;
		const declared = declaredCategory(row.name ?? "", options.naming);
		const expected = manifestByAssetId.get(row.asset_id)?.category ?? declared;
		if (expected === null || expected === remoteType) continue;
		mismatches.push({
			asset_id: row.asset_id,
			name: row.name,
			asset_type: ASSET_CATEGORY_TYPES[remoteType],
			manifest_category: manifestByAssetId.get(row.asset_id)?.category ?? null,
			declared_category: declared,
			expected
		});
	}
	const folders = {
		角色: [],
		场景: [],
		道具: []
	};
	for (const category of ASSET_CATEGORIES) folders[category] = readFolderTree((await client.request({
		method: "GET",
		path: `/aigc/assetFolder/tree?assetScopeType=${ASSET_SCOPES.personal}&rootCategoryType=${ASSET_CATEGORY_TYPES[category]}`
	})).data);
	const tasksByEpisode = /* @__PURE__ */ new Map();
	for (const task of tasks.rows) {
		const token = task.task_name === null ? null : carriedEpisode(task.task_name, options.naming);
		if (token === null || token === options.naming.seriesLabel) continue;
		const key = token.slice(2);
		const rows = tasksByEpisode.get(key) ?? [];
		rows.push({
			task_id: task.task_id,
			task_name: task.task_name,
			status: task.status
		});
		tasksByEpisode.set(key, rows);
	}
	const episodes = [...new Set([...buckets.keys(), ...tasksByEpisode.keys()])].sort().map((key) => {
		const categories = buckets.get(key) ?? emptyBuckets();
		return {
			episode: key,
			label: `EP${key}`,
			categories,
			asset_count: ASSET_CATEGORIES.reduce((total, category) => total + categories[category].length, 0),
			video_tasks: tasksByEpisode.get(key) ?? []
		};
	});
	const indexPath = resolve(projectRoot, options.indexPath ?? DEFAULT_INDEX_PATH);
	if (!indexPath.startsWith(`${projectRoot}${sep}`)) throw new JubianError("CONTRACT_CHANGED", "索引路径必须落在项目目录内");
	const index = {
		script_id: scriptId,
		project_dir: projectRoot,
		source_manifest: join(projectRoot, "assets_manifest.json"),
		convention: `EP{两位集数}${options.naming.separator}{类别}${options.naming.separator}{名称}，跨集母版用 ${options.naming.seriesLabel}`,
		episodes,
		series,
		unmatched_remote_assets: assets.filter((row) => !matched.has(row.asset_id)).map((row) => ({
			asset_id: row.asset_id,
			name: row.name
		})),
		naming_checked: checked,
		naming_violations: violations,
		folders,
		folder_scope: `个人资产（assetScopeType=${ASSET_SCOPES.personal}）`,
		category_mismatches: mismatches,
		video_tasks_total: tasks.total,
		index_path: indexPath,
		next: `这是只读视图：没有重命名、没有移动、没有改动任何远端资产。不符合规范的名字与类别不一致的资产只在这里报告——批量改名或搬家需要用户明确同意，再用 jubian_asset rename / create_folder / move 执行。索引文件已写到 ${indexPath}。`
	};
	await atomicWriteText(indexPath, renderMarkdown(index));
	return index;
}
//#endregion
//#region lib/types/model-settings.js
/** Free, frozen, scoped changes to existing storyboard model settings. */
const INTENT_KEYS = [
	"modelId",
	"platformId",
	"ratio",
	"resolution",
	"genType",
	"duration",
	"genNum"
];
const MODEL_KEYS = [
	...INTENT_KEYS,
	"standardId",
	"modelGenerationTypeId",
	"videoStandardId"
];
const PROVIDER_AUDIT_KEYS = [
	"updateTime",
	"updateBy",
	"createTime",
	"createBy"
];
function fail(detail) {
	throw new JubianError("CONTRACT_CHANGED", detail);
}
function object(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Expected a JSON object");
	return value;
}
function id(value) {
	const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return fail("Invalid remote ID");
	return number;
}
function ids(value) {
	if (!Array.isArray(value)) return fail("Expected remote ID list");
	const result = value.map(id).sort((a, b) => a - b);
	if (new Set(result).size !== result.length) return fail("Duplicate remote IDs");
	return result;
}
function changesOf(value) {
	const changes = object(value);
	if (!Object.keys(changes).length || Object.keys(changes).some((key) => !INTENT_KEYS.includes(key))) return fail("changes accepts only modelId/platformId/ratio/resolution/genType/duration/genNum");
	for (const [key, value] of Object.entries(changes)) if ([
		"genType",
		"duration",
		"genNum"
	].includes(key)) id(value);
	else if (typeof value !== "string" || !value.trim()) fail(`Invalid ${key}`);
	return changes;
}
function selectorOf(args) {
	const scope = args.scope;
	if (scope !== "storyboards" && scope !== "episodes" && scope !== "project") return fail("Explicit scope required");
	const storyboard_ids = args.storyboard_ids === void 0 ? [] : ids(args.storyboard_ids);
	const episode_ids = args.episode_ids === void 0 ? [] : ids(args.episode_ids);
	if (scope === "storyboards" && !storyboard_ids.length || scope === "episodes" && !episode_ids.length || scope !== "storyboards" && storyboard_ids.length || scope !== "episodes" && episode_ids.length) return fail("Scope and exact remote IDs disagree");
	return {
		scope,
		storyboard_ids,
		episode_ids
	};
}
function configOf(board) {
	try {
		return object(typeof board.modelConfig === "string" ? JSON.parse(board.modelConfig) : board.modelConfig);
	} catch (error) {
		return fail(error instanceof JubianError ? error.message : "Invalid modelConfig JSON");
	}
}
function settings(config) {
	return Object.fromEntries(MODEL_KEYS.filter((key) => config[key] !== void 0).map((key) => [key, config[key]]));
}
function hash(value) {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}
function snapshot(board) {
	const { isGenerate: _generate, ...rest } = board;
	return {
		...rest,
		modelConfig: configOf(board)
	};
}
/**
* Fields the provider rewrites inside a material row every time it saves a storyboard.
*
* The row's surrogate id and its audit columns are regenerated on each save, so keeping
* them made the preserved hash differ after every successful write. Everything the row
* means — `materialKey`, `assetId`, `materialAssetId`, `fileName`, `materialUrl`,
* `sortOrder` — stays, so a wiped, reordered or replaced material list still differs.
*/
const MATERIAL_ROW_VOLATILE_KEYS = ["id", ...PROVIDER_AUDIT_KEYS];
/** One nested list with the provider's per-save churn removed; order is preserved. */
function withoutRowChurn(value) {
	if (!Array.isArray(value)) return value;
	return value.map((row) => {
		if (!row || typeof row !== "object" || Array.isArray(row)) return row;
		return Object.fromEntries(Object.entries(row).filter(([key]) => !MATERIAL_ROW_VOLATILE_KEYS.includes(key)));
	});
}
function preservedHash(board) {
	const rest = Object.fromEntries(Object.entries(snapshot(board)).filter(([key]) => key !== "modelConfig" && !PROVIDER_AUDIT_KEYS.includes(key)).map(([key, value]) => [key, key === "storyboardMaterialList" ? withoutRowChurn(value) : value]));
	const nonModel = Object.fromEntries(Object.entries(configOf(board)).filter(([key]) => !MODEL_KEYS.includes(key)));
	return hash({
		...rest,
		modelConfig: nonModel
	});
}
/**
* Whether the board matches everything the preview froze: the model settings it
* asked for, and every field outside them.
*
* The preserved half is a real guard — a save that empties `storyboardMaterialList`
* destroys the ordered subject identity — so it stays a failure. It is also what
* currently misfires, because the provider rewrites each material row's own audit
* fields on every save. Normalizing those churned fields out of `preservedHash`
* is the fix; until then a successful write can still read back as a mismatch.
*/
function matches(board, target) {
	return preservedHash(board) === target.preserved_hash && stableJson(settings(configOf(board))) === stableJson(target.after);
}
function fingerprint(plan) {
	return hash(plan);
}
async function targets(client, scriptId, selector) {
	if (selector.scope === "storyboards") return selector.storyboard_ids;
	const collected = [];
	const seen = /* @__PURE__ */ new Set();
	let total;
	for (let page = 1; page <= 40; page++) {
		const data = (await client.request({
			method: "GET",
			path: `/aigc/storyboard/list?scriptId=${scriptId}&pageNum=${page}&pageSize=100`
		})).data;
		const envelope = Array.isArray(data) ? { rows: data } : object(data);
		const rows = envelope.rows ?? envelope.list;
		if (!Array.isArray(rows)) fail("Unreadable storyboard list");
		if (envelope.total !== void 0) {
			const count = envelope.total;
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || total !== void 0 && count !== total) fail("Storyboard list total drift");
			total = count;
		}
		for (const raw of rows) {
			const row = object(raw);
			const key = id(row.id);
			if (seen.has(key) || id(row.scriptId) !== scriptId) fail("Storyboard list identity mismatch");
			seen.add(key);
			collected.push(row);
		}
		if (total !== void 0 && collected.length > total) fail("Storyboard list total mismatch");
		if (total === collected.length || total === void 0 && rows.length < 100) {
			const selected = collected.filter((row) => selector.scope === "project" || selector.episode_ids.includes(id(row.episodeId)));
			if (!selected.length || selector.scope === "episodes" && selector.episode_ids.some((episode) => !selected.some((row) => id(row.episodeId) === episode))) fail("Scope has no storyboards for one or more requested episodes");
			return selected.map((row) => id(row.id)).sort((a, b) => a - b);
		}
		if (rows.length < 100) fail("Incomplete storyboard list");
	}
	return fail("Storyboard list exceeds 40 pages");
}
async function readBoard(client, scriptId, storyboardId) {
	const board = object((await client.request({
		method: "GET",
		path: `/aigc/storyboard/${storyboardId}`
	})).data);
	if (id(board.id) !== storyboardId || id(board.scriptId) !== scriptId) fail("Storyboard identity mismatch");
	return board;
}
function targetOf(board, catalogue, changes) {
	const before = configOf(board);
	const intent = {
		...before,
		...changes
	};
	if (changes.modelId !== void 0 && changes.modelId !== before.modelId && changes.platformId === void 0) delete intent.platformId;
	const after = resolveVideoModel(catalogue, intent);
	return {
		storyboard_id: id(board.id),
		episode_id: id(board.episodeId),
		before_hash: hash(snapshot(board)),
		preserved_hash: preservedHash(board),
		before: settings(before),
		after: settings({ ...after })
	};
}
async function build(client, scriptId, selector, changes) {
	const catalogue = (await client.request({
		method: "GET",
		path: "/model/charge/getSelectList?taskType=1"
	})).data;
	const items = [];
	for (const key of await targets(client, scriptId, selector)) {
		const target = targetOf(await readBoard(client, scriptId, key), catalogue, changes);
		if (selector.scope === "episodes" && !selector.episode_ids.includes(target.episode_id)) fail("Episode membership drift");
		items.push(target);
	}
	const plan = {
		version: 2,
		operation: "storyboard_model_settings",
		script_id: scriptId,
		selector,
		changes,
		targets: items
	};
	return {
		...plan,
		fingerprint: fingerprint(plan)
	};
}
function parsePlan(value) {
	const row = object(value);
	if (row.version === 1) return fail("这份计划由旧版本生成，当时的保存核对会把服务端重建素材行误判成失败；请重新 preview");
	if (row.version !== 2 || row.operation !== "storyboard_model_settings" || !Array.isArray(row.targets) || !row.targets.length) return fail("Invalid model settings plan");
	const parsedTargets = row.targets.map((raw) => {
		const target = object(raw);
		if (typeof target.before_hash !== "string" || !/^[a-f0-9]{64}$/.test(target.before_hash) || typeof target.preserved_hash !== "string" || !/^[a-f0-9]{64}$/.test(target.preserved_hash)) fail("Invalid snapshot hash");
		return {
			storyboard_id: id(target.storyboard_id),
			episode_id: id(target.episode_id),
			before_hash: target.before_hash,
			preserved_hash: target.preserved_hash,
			before: object(target.before),
			after: object(target.after)
		};
	});
	ids(parsedTargets.map((target) => target.storyboard_id));
	const plan = {
		version: 2,
		operation: "storyboard_model_settings",
		script_id: id(row.script_id),
		selector: selectorOf(object(row.selector)),
		changes: changesOf(row.changes),
		targets: parsedTargets
	};
	const result = {
		...plan,
		fingerprint: fingerprint(plan)
	};
	if (row.fingerprint !== result.fingerprint || stableJson(row) !== stableJson(result)) fail("Plan fingerprint mismatch");
	return result;
}
function destination(project, key) {
	return join(project, "video_tasks", `${key}.model-settings.prepared.json`);
}
function verifyClaim(record, expectedHash) {
	if (record.method !== "storyboard_model_settings" || expectedHash !== void 0 && record.request_sha256 !== expectedHash) fail("Idempotency key belongs to a different write");
}
async function applyPlan(client, ledger, args) {
	const key = requireKey(args.idempotency_key);
	const scriptId = id(need(args.script_id, "script_id"));
	const binding = await validateProjectBinding(need(args.project_dir, "project_dir"), scriptId);
	const path = resolve(need(args.preview_path, "preview_path"));
	let raw;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		return fail(error instanceof Error ? "Cannot read model settings plan" : "Invalid plan");
	}
	const plan = parsePlan(raw);
	if (key !== plan.fingerprint || scriptId !== plan.script_id || path !== destination(binding.project_root, key)) fail("Plan project/path/key mismatch");
	const previous = await ledger.find(key);
	if (previous !== void 0) {
		verifyClaim(previous, `sha256:${key}`);
		const items = [];
		for (const target of plan.targets) {
			const recorded = await ledger.find(`${key}:${target.storyboard_id}`);
			let status = "not_attempted";
			if (recorded !== void 0) {
				verifyClaim(recorded);
				try {
					status = matches(await readBoard(client, scriptId, target.storyboard_id), target) ? "applied" : "readback_mismatch";
				} catch {
					status = "unknown";
				}
			}
			items.push({
				storyboard_id: target.storyboard_id,
				status
			});
		}
		return {
			status: "replayed",
			replayed: true,
			paid_requests: 0,
			items,
			next: "No requests resent. Read current storyboards to reconcile; this plan will not resume remaining targets."
		};
	}
	if ((await build(client, scriptId, plan.selector, plan.changes)).fingerprint !== key) fail("Stale targets, membership or catalogue; preview again");
	const items = plan.targets.map((target) => ({
		storyboard_id: target.storyboard_id,
		status: "not_attempted"
	}));
	if ((await ledger.begin({
		idempotencyKey: key,
		method: "storyboard_model_settings",
		requestSha256: `sha256:${key}`
	})).replayed) return applyPlan(client, ledger, args);
	for (const [index, target] of plan.targets.entries()) {
		const item = need(items[index]);
		const state = { sent: false };
		try {
			const board = await readBoard(client, scriptId, target.storyboard_id);
			if (hash(snapshot(board)) !== target.before_hash) {
				item.status = "stale";
				break;
			}
			const nextConfig = {
				...configOf(board),
				...target.after
			};
			const body = {
				...board,
				isGenerate: 0,
				modelConfig: typeof board.modelConfig === "string" ? JSON.stringify(nextConfig) : nextConfig
			};
			const saved = await writeUnderLedger(ledger, `${key}:${target.storyboard_id}`, "storyboard_model_settings", () => body, (payload) => {
				state.sent = true;
				return client.request({
					method: "PUT",
					path: "/aigc/storyboard",
					body: need(payload)
				});
			});
			if (saved.replayed || saved.outcome !== "accepted") {
				item.status = "unknown";
				break;
			}
			if (!matches(await readBoard(client, scriptId, target.storyboard_id), target)) {
				item.status = "readback_mismatch";
				continue;
			}
			item.status = "applied";
		} catch (error) {
			item.status = state.sent ? "unknown" : "stale";
			item.error = error instanceof JubianError ? error.code : "REQUEST_OR_READBACK_FAILED";
			break;
		}
	}
	return {
		status: items.every((item) => item.status === "applied") ? "applied" : "partial",
		replayed: false,
		paid_requests: 0,
		items,
		next: "Existing storyboards only; defaults and produced media are unchanged. On partial outcome, reconcile before a new preview; never change keys to retry."
	};
}
/**
* Preview or apply an explicit scope of existing storyboard settings without generation.
* @param client - Jubian transport; previews issue only GET requests.
* @param ledger - Existing write ledger; a claimed plan never resumes or resends.
* @param args - Project binding, exact scope and partial model intent, or frozen preview/key.
* @returns Before/after preview or per-target apply outcomes.
*/
async function modelMethod(client, ledger, args) {
	if (args.method === "preview") {
		const scriptId = id(need(args.script_id, "script_id"));
		const selector = selectorOf(args);
		const changes = changesOf(args.changes);
		const binding = await validateProjectBinding(need(args.project_dir, "project_dir"), scriptId);
		const plan = await build(client, scriptId, selector, changes);
		const path = destination(binding.project_root, plan.fingerprint);
		await atomicWriteJson(path, plan);
		return {
			...plan,
			preview_path: path,
			paid_requests: 0,
			next: "Review every before/after setting and scope. Apply with this preview_path and idempotency_key=fingerprint; no remote changes have been made."
		};
	}
	if (args.method !== "apply") return fail("Unknown model settings method");
	return applyPlan(client, ledger, args);
}
//#endregion
//#region lib/types/token.js
/**
* Host half of the Jubian token Settings page: the `jubianToken` Remote
* namespace, over exactly one credential reference.
*
* **One reference, fixed here.** `ctx.remote.credentials` writes any reference
* a page names; this namespace writes only {@link JUBIAN_TOKEN_REF}, so the
* browser that owns this page cannot repoint another provider's credential
* even if the page is compromised.
*
* **The value crosses in one direction.** `set` takes a value; no method
* returns one. Every answer is the credential seam's own configuration view —
* configured, source, writable — projected field by field, because the Gateway
* carries a business result without decoding it and a provider that returned
* extra properties would otherwise widen what reaches the browser.
*
* @module @deepseek-ai/dsh-tool-jubian/src/token
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** The one reference this namespace reads and writes. */
const REF = credentialRef(JUBIAN_TOKEN_REF);
/**
* Copy exactly the fields {@link CredentialInfo} declares.
* @param info - the provider's answer for the Jubian reference.
* @returns the same facts with nothing else attached.
*/
function viewOf(info) {
	return {
		configured: info.configured,
		...info.source === void 0 ? {} : { source: info.source },
		writable: info.writable
	};
}
/**
* Host service backing the generated `ctx.remote.jubianToken` namespace: the
* Jubian admin token as the Web Settings page reads, writes, and clears it.
*/
let JubianToken = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _describe_decorators;
	let _set_decorators;
	let _unset_decorators;
	return class JubianToken extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_describe_decorators = [Remote];
			_set_decorators = [Remote];
			_unset_decorators = [Remote];
			__esDecorate(this, null, _describe_decorators, {
				kind: "method",
				name: "describe",
				static: false,
				private: false,
				access: {
					has: (obj) => "describe" in obj,
					get: (obj) => obj.describe
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _set_decorators, {
				kind: "method",
				name: "set",
				static: false,
				private: false,
				access: {
					has: (obj) => "set" in obj,
					get: (obj) => obj.set
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _unset_decorators, {
				kind: "method",
				name: "unset",
				static: false,
				private: false,
				access: {
					has: (obj) => "unset" in obj,
					get: (obj) => obj.unset
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["credentials"];
		/** @param ctx - Host context carrying the credential provider. */
		constructor(ctx) {
			super(ctx, "jubianToken");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		* Describe the stored token without reading it.
		* @returns whether a value is configured, which source supplies it, and whether this deployment can write it.
		*/
		async describe() {
			return viewOf(await this.ctx.credentials.describe(REF));
		}
		/**
		* Store one value under the fixed reference.
		* @param value - the token; an empty or whitespace-only value is refused.
		* @returns the same facts {@link describe} reports after the write.
		* @throws RemoteError when the value is empty, or when the provider refuses the write.
		*/
		async set(value) {
			if (value.trim().length === 0) throw new RemoteError("gateway/bad-request", "the Jubian admin token must not be empty; clear it with unset instead", {});
			await this.write(() => this.ctx.credentials.set(REF, value));
			return await this.describe();
		}
		/**
		* Remove the stored value. Removing an absent reference is a no-op.
		* @returns the same facts {@link describe} reports after the removal.
		* @throws RemoteError when the provider refuses the write.
		*/
		async unset() {
			await this.write(() => this.ctx.credentials.unset(REF));
			return await this.describe();
		}
		/**
		* Run one write and report a refusal with the seam's own message. A
		* read-only source shadowing the reference is what the page must show
		* verbatim, and the details carry no field a value could ride in.
		* @param write - the credential operation to run.
		*/
		async write(write) {
			try {
				await write();
			} catch (error) {
				throw new RemoteError("jubian-token/rejected", error instanceof Error ? error.message : String(error), { ref: JUBIAN_TOKEN_REF }, { cause: error });
			}
		}
	};
})();
//#endregion
//#region lib/types/watch.js
/** Process-local, read-only observation of one accepted Jubian operation. */
/**
* Resolve and validate polling budgets at plugin mount.
* @param config - Optional deployment budgets.
* @returns Bounded polling and total timeout values.
*/
function resolveWatchConfig(config) {
	const resolved = {
		watchPollIntervalMs: config.watchPollIntervalMs ?? 15e3,
		watchTimeoutMs: config.watchTimeoutMs ?? 18e5
	};
	for (const [key, maximum] of [["watchPollIntervalMs", 6e4], ["watchTimeoutMs", 864e5]]) if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1 || resolved[key] > maximum) throw new TypeError(`${key} must be an integer within 1..${maximum}`);
	return resolved;
}
/**
* Validate model-authored operation identity before job admission.
* @param args - Tool input.
* @returns The validated operation identity.
*/
function watchArgs(args) {
	if (!Number.isSafeInteger(args.task_id) || args.task_id < 1 || ![
		"generate",
		"upscale",
		"erase_subtitle"
	].includes(args.stage)) throw new TypeError("jubian_watch requires a positive safe-integer operation task_id and generate, upscale, or erase_subtitle stage");
	return args;
}
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function currentOutput(row, raw, stage) {
	if (!row.video_url || row.last_task_type !== null && row.last_stage !== stage) return false;
	if (stage === "generate" && row.last_task_type === null && row.video_url === row.base_video_url) return true;
	const results = record(raw)?.resultList;
	const current = Array.isArray(results) ? record(results[0]) : void 0;
	if (row.last_stage === stage && current?.lastResultStatus !== void 0) return terminalOutcome(String(current.lastResultStatus)) === "succeeded" && current.lastTosVideoUrl === row.video_url;
	return Array.isArray(results) && results.some((value) => {
		const version = record(value);
		return version !== void 0 && typeof version.taskType === "number" && VIDEO_TASK_TYPES[version.taskType] === stage && (version.tosVideoUrl ?? version.originalVideoUrl) === row.video_url && typeof version.resultStatus === "string" && terminalOutcome(version.resultStatus) === "succeeded";
	});
}
async function observe(client, args, signal) {
	const task = readTaskPage((await client.request({
		method: "GET",
		path: `/admin/aigc/video/task/${args.task_id}`,
		signal
	})).data);
	if (task.task_id !== args.task_id || task.task_type === null || VIDEO_TASK_TYPES[task.task_type] !== args.stage) return;
	const status = terminalOutcome(task.status ?? "");
	if (status === "failed") return {
		status: "failed",
		detail: `provider operation ${task.status}`
	};
	if (status !== "succeeded") return;
	const rows = [];
	const seen = /* @__PURE__ */ new Set();
	let total;
	for (let pageNum = 1;; pageNum++) {
		signal.throwIfAborted();
		const response = await client.request({
			method: "POST",
			path: `/admin/aigc/video/task/sub/list?pageNum=${pageNum}&pageSize=1000`,
			body: { aigcVideoTaskId: args.task_id },
			signal
		});
		const raw = record(response.data);
		if (!Number.isSafeInteger(raw?.total) || raw.total < 1) return;
		const page = readSubtaskPage(response.data);
		if (total !== void 0 && page.total !== total) return;
		total = page.total;
		if (!page.rows.length || rows.length + page.rows.length > total) return;
		for (const [index, row] of page.rows.entries()) {
			if (row.parent_task_id !== args.task_id || seen.has(row.subtask_id)) return;
			seen.add(row.subtask_id);
			if (terminalOutcome(row.status ?? "") === "failed") return {
				status: "failed",
				detail: `provider child ${row.subtask_id} ${row.status}`
			};
			if (terminalOutcome(row.status ?? "") !== "succeeded" || !currentOutput(row, raw.rows[index], args.stage)) return;
			rows.push(row);
		}
		if (rows.length === total) break;
	}
	return {
		status: "completed",
		detail: `${args.stage} operation verified; review required`,
		output: JSON.stringify({
			...args,
			status: "succeeded",
			outputs: rows.map((row) => ({
				subtask_id: row.subtask_id,
				video_url: row.video_url,
				first_result_id: row.first_result_id,
				parent_result_id: row.parent_result_id,
				resolution: row.resolution
			})),
			next: "Review every output with frame/audio inspection and verify delivery resolution. Provider completion is not visual QA; subtitle removal still needs visual review. Do not repeat paid operations automatically."
		}, null, 2)
	};
}
/**
* Start abortable polling; the caller must admit this work through jobs.start.
* @param client - Existing credential-aware read transport.
* @param args - Validated accepted operation identity.
* @param config - Resolved polling budgets.
* @returns Synchronous idempotent cancellation and settlement after timer/request cleanup.
*/
function watchJob(client, args, config) {
	const controller = new AbortController();
	const timeout = /* @__PURE__ */ new Error("timeout: operation completion unverified");
	const timer = setTimeout(() => controller.abort(timeout), config.watchTimeoutMs);
	return {
		cancel: () => {
			controller.abort();
		},
		done: (async () => {
			try {
				for (;;) {
					controller.signal.throwIfAborted();
					try {
						const outcome = await observe(client, args, controller.signal);
						controller.signal.throwIfAborted();
						if (outcome) return outcome;
					} catch (error) {
						controller.signal.throwIfAborted();
						if (!(error instanceof JubianError) || error.code !== "CONTRACT_CHANGED") throw error;
					}
					await setTimeout$1(config.watchPollIntervalMs, void 0, { signal: controller.signal });
				}
			} catch (error) {
				if (controller.signal.aborted) return controller.signal.reason === timeout ? {
					status: "failed",
					detail: timeout.message
				} : {
					status: "killed",
					detail: "watch cancelled; provider operation unchanged"
				};
				return {
					status: "failed",
					detail: error instanceof JubianError ? error.code : "watch read failed"
				};
			} finally {
				clearTimeout(timer);
			}
		})()
	};
}
//#endregion
//#region lib/types/index.js
/**
* Jubian tools: one plugin row any DSH preset can mount.
*
* The tool descriptions carry the facts a model cannot infer from the schema:
* which methods really cost money, which one changes provider state through a
* GET verb, and that a timeout never means "safe to retry".
*
* Every write method requires the caller's `idempotency_key`. The key is never
* generated here: a generated key would let a retry after an ambiguous outcome
* bypass the record of the first attempt, which is the only thing standing
* between a timeout and a second charge.
*
* The row mounts {@link JubianToken} beside the tools. The same credential the
* tools resolve is the one a person edits in Web Settings, so the page that
* writes it belongs to the package that consumes it rather than to a generic
* configuration surface that can write any reference.
*/
const name = "tool-jubian";
const inject = ["tools", "credentials"];
/** The one sentence every write method's description carries. */
const WRITE_NOTE = "写方法必须提供 idempotency_key：同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。";
/** The workspace-relative secret file the pipeline skills already use. */
const PIPELINE_ENV = join(".agents", "secrets", "pipeline.env");
/**
* Read the pipeline token from the nearest workspace secret file.
*
* The credential store stays the source of truth: this runs only when that store
* has no usable value, because the pipeline's own client resolves the same file
* and a session that lost the store entry should not lose its login with it. The
* value never enters a result, a log or a preview.
* @param start - Directory to search upward from, normally the launch directory.
* @returns The token, or an empty string when no file in the chain carries one.
*/
async function workspacePipelineToken(start) {
	let directory = resolve(start);
	for (let hop = 0; hop < 12; hop += 1) {
		try {
			const text = await readFile(join(directory, PIPELINE_ENV), "utf8");
			const values = /* @__PURE__ */ new Map();
			for (const line of text.split("\n")) {
				const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
				const name = match?.[1];
				if (name === void 0) continue;
				values.set(name, (match?.[2] ?? "").replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
			}
			return values.get("JUBIANAI_ADMIN_TOKEN") ?? values.get("JUBIANAI_TOKEN") ?? "";
		} catch {}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return "";
}
/** Arguments shared by more than one tool; each tool lists only what it accepts. */
const ARGS = {
	idempotency_key: {
		type: "string",
		description: `写方法必填；读方法忽略。${WRITE_NOTE}`
	},
	task_type: {
		type: "number",
		description: "models 必填：1=视频，2=图片，10=去字幕。"
	},
	standard_id: {
		type: "number",
		description: "rate 必填：计价标准 ID。"
	},
	script_id: {
		type: "number",
		description: "剧变项目 ID（scriptId）。erase_subtitle 与 upscale 从任务行读取它，不必单独提供；其余方法按上面的必填说明传入。"
	},
	page_num: {
		type: "number",
		description: "页码，默认 1。"
	},
	page_size: {
		type: "number",
		description: "每页条数，默认 20，上限 1000。"
	},
	asset_id: {
		type: "number",
		description: "get / generated_image 必填：主体资产 ID。"
	},
	material_id: {
		type: "number",
		description: "confirm_casting 必填：生成材质 ID（不是父资产、不是任务 ID）。"
	},
	storyboard_id: {
		type: "number",
		description: "分镜 ID。"
	},
	task_id: {
		type: "number",
		description: "task / subtasks 必填：视频任务 ID。"
	},
	asset_name: {
		type: "string",
		description: "image_generate 必填、rename 必填：资产名。给了 episode 时这里只写资产自己的名字（如 `红包`），插件按规范补齐前缀与类别段；不给 episode 时原样发送。rename 发送的就是最终的完整名称。"
	},
	asset_type: {
		type: "number",
		enum: [
			1,
			2,
			3
		],
		description: "image_generate 的资产类别号：1=角色，2=场景，3=道具。给了 asset_category 时可以不传（插件按类别推导）；两个都给时必须一致。场景与道具必须传 2/3——一律传 1 会把它们建进控制台的角色库。"
	},
	prompt: {
		type: "string",
		description: "image_generate 必填：图片提示词。"
	},
	references: {
		type: "array",
		items: { type: "string" },
		description: "image_generate 可选：有序参考图 HTTPS URL，顺序即生成顺序。"
	},
	parent_asset_id: {
		type: "number",
		description: "image_generate 可选：给了就是重生成（PUT），不给是新建（POST）。"
	},
	asset_url: {
		type: "string",
		description: "register 必填：这条新资产要引用的图片 HTTPS 地址（通常是原资产的 materialUrl）。register 按它新建资产，不生成新图。"
	},
	content_duration_ms: {
		type: "number",
		description: "generate 必填：本包内容时长，4000–14000 的整千毫秒。"
	},
	model_id: {
		type: "string",
		description: "erase_subtitle 必填：quzimuToB（羽点，区域性）或 ark-erase-video-subtitle-pro（自动）。插件不设默认值——省略即在发请求前报错，不会替你挑一个模型。"
	},
	task_name: {
		type: "string",
		description: "erase_subtitle 可选：任务名，省略时按「<源任务名>-去字幕」生成。"
	},
	first_result_id: {
		type: "number",
		description: "erase_subtitle 必填：源视频 firstResultId。"
	},
	parent_result_id: {
		type: "number",
		description: "erase_subtitle 必填：源视频 parentResultId。"
	},
	video_url: {
		type: "string",
		description: "erase_subtitle 必填：源视频 HTTPS URL。"
	},
	duration: {
		type: "number",
		description: "erase_subtitle 必填：源视频秒数。"
	},
	video_width: {
		type: "number",
		description: "erase_subtitle 必填：画面宽度。"
	},
	video_height: {
		type: "number",
		description: "erase_subtitle 必填：画面高度。"
	},
	subtitle_box: {
		type: "object",
		additionalProperties: true,
		description: "erase_subtitle 可选：{zimuLeft,zimuTop,zimuWidth,zimuHeight}。省略时按画面尺寸推导提供方默认比例——通常不要传，工作台的预览坐标无法由调用方复现。"
	},
	body: {
		type: "object",
		additionalProperties: true,
		description: "create 二选一：完整的远端请求体（本插件不做体编译）。"
	},
	body_path: {
		type: "string",
		description: "create 二选一：包含完整冻结请求体的本地 UTF-8 JSON 文件路径。"
	},
	media_url: {
		type: "string",
		description: "media 必填：剧变 CDN 上的媒体 URL（来自其他方法的返回值）。"
	},
	media_kind: {
		type: "string",
		enum: ["image", "video"],
		description: "media 必填：要下载的是图片还是视频。"
	},
	output_path: {
		type: "string",
		description: "media 必填：落盘的本地绝对路径。"
	},
	delivery_resolution: {
		type: "string",
		description: "subtasks 可选但强烈建议：本次要交付的分辨率，如 1080p。给定后每行都会得到 needs_upscale：低于该分辨率的结果为 true，否则为 false，无法判断时为 null。true 仅提示实际分辨率低于交付尺寸，不是内容不可用判定，也不构成付费义务。"
	},
	image_path: {
		type: "string",
		description: "upload_reference 必填：本地参考图路径（jpg/jpeg/png/webp）。"
	},
	project_dir: {
		type: "string",
		description: "prepare_video 必填、submit_video 可选：项目目录，必须含 project_config.json，且其 jubian_script_id 必须等于实时 scriptId。"
	},
	preview_path: {
		type: "string",
		description: "submit_video 必填：prepare_video 返回的 preview_path，不要猜测或手写文件名。"
	},
	selections: {
		type: "array",
		items: {
			type: "object",
			additionalProperties: false,
			properties: {
				material_key: {
					type: "string",
					required: true,
					description: "提示词里 @[名称](key) 的 key。"
				},
				asset_id: {
					type: "number",
					required: true,
					description: "主体设定行的父资产 ID（materials 返回的 asset_id）。"
				}
			}
		},
		description: "select_assets 必填：有序的 (material_key, 父 asset_id) 列表，顺序必须与提示词里的 key 顺序完全一致。"
	},
	episode: {
		type: "string",
		description: "可选：集号（`5` 与 `05` 都规范成 `EP05`）或配置的跨集母版标记（默认「全剧」）。给了它，资产名会按规范组合成 `EP05｜角色｜陆沉舟`，处理任务名会加上 `EP05-P3-` 这样的可排序前缀；不给就完全按调用方原样使用 asset_name / task_name。"
	},
	asset_category: {
		type: "string",
		enum: [...ASSET_CATEGORIES],
		description: "资产类别。与 episode 同时给出时决定资产名里的类别段，并决定 image_generate 的 assetType（角色=1、场景=2、道具=3）——场景与道具必须传对应类别，否则资产会落进控制台的角色库。"
	},
	package_number: {
		type: "string",
		description: "erase_subtitle / upscale 可选：本集内的包号，配合 episode 生成 `EP05-P3` 前缀。"
	},
	folder_name: {
		type: "string",
		description: "create_folder 必填：文件夹名，例如 `EP05`。"
	},
	parent_id: {
		type: "number",
		description: "create_folder 可选：父文件夹 ID；省略则建在该类别库的根下（根自己的 ID 就是 root_category_type 的数字）。"
	},
	asset_scope_type: {
		type: "number",
		enum: [1, 2],
		description: "create_folder / move 必填：1=团队资产，2=个人资产。资产在哪个库就在哪个库建夹与移动。"
	},
	root_category_type: {
		type: "number",
		enum: [
			1,
			2,
			3
		],
		description: "create_folder / move 必填：1=角色库，2=场景库，3=道具库。move 只用它在本地读文件夹树做前置校验，请求体仍与前端一致（不发这个字段）。"
	},
	material_ids: {
		type: "array",
		items: { type: "number" },
		description: "move 必填：要移动的材质行 ID（素材列表里每行的 id，不是父 asset_id）。"
	},
	target_folder_id: {
		type: "number",
		description: "move 必填：目标文件夹 ID；要放回库根目录就传该库的 root_category_type 数字。"
	}
};
/** One shared output contract: a canonical JSON object rendered as pretty text. */
const OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: true
	},
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}]
};
/**
* Adapt one domain method to the tool registry.
*
* The registry types arguments from the authored parameter spec and requires a
* losslessly-JSON return value, while these methods take one wide argument bag
* and may carry provider values the transport kept as `unknown`. Both casts are
* at this single seam rather than at every call site; the runtime shape is the
* same either way.
*
* The required-argument check runs here, before dispatch, so a call missing an
* argument its method cannot run without fails without a request, a ledger line
* or any provider state change.
* @param tool - Registered tool name, which keys {@link REQUIRED_ARGUMENTS}.
* @param run - The domain method, given the validated argument bag.
* @returns An execute function for `defineTool`.
*/
function guarded(tool, run) {
	return async (args) => {
		const dispatched = args;
		requireArguments(tool, dispatched);
		return await run(dispatched);
	};
}
/**
* Install the Jubian tools and the two Remote namespaces they expose.
* @param ctx - Host context carrying `tools` and `credentials`.
* @param config - Optional ledger location, origin, timeout and image-route values.
*/
function apply(ctx, config = {}) {
	const watchConfig = resolveWatchConfig(config);
	ctx.plugin(JubianToken);
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const naming = resolveNaming({
		...config.nameSeparator === void 0 ? {} : { separator: config.nameSeparator },
		...config.seriesLabel === void 0 ? {} : { seriesLabel: config.seriesLabel }
	});
	const ledger = new JubianLedger({
		root: config.ledgerRoot ?? join(home, "jubian", "ledger"),
		defaultLimitCents: () => seriesBudgetLimit(ctx)
	});
	const client = new JubianClient({
		credential: async () => {
			const stored = (await ctx.credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? "";
			if (stored.trim()) return stored;
			return config.workspaceSecrets === false ? "" : await workspacePipelineToken(process.cwd());
		},
		...config.baseUrl === void 0 ? {} : { baseUrl: config.baseUrl },
		...config.timeoutMs === void 0 ? {} : { timeoutMs: config.timeoutMs }
	});
	ctx.plugin(JubianImageRoutes, { client });
	const image = () => ({
		selection: pinnedImageSelection(ctx, config),
		...config.imageActiveTimeoutMs === void 0 ? {} : { activeTimeoutMs: config.imageActiveTimeoutMs },
		...config.imageActivePollMs === void 0 ? {} : { pollIntervalMs: config.imageActivePollMs }
	});
	ctx.tools.register(defineTool({
		name: "jubian_catalog",
		description: "剧变（Jubian）目录与项目只读查询：账户模型目录与报价、剧本、分集。全部只读，不产生费用。",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"models",
					"rate",
					"script",
					"episodes"
				],
				description: "models=账户模型目录；rate=单个计价标准；script=剧本身份；episodes=分集列表。"
			},
			task_type: ARGS.task_type,
			standard_id: ARGS.standard_id,
			script_id: ARGS.script_id,
			page_num: ARGS.page_num,
			page_size: ARGS.page_size
		},
		output: OUTPUT,
		execute: guarded("jubian_catalog", (args) => catalogMethod(client, args))
	}));
	ctx.tools.register(defineTool({
		name: "jubian_asset",
		description: "剧变（Jubian）主体设定与资产的查询、确认出演与删除。get/list/materials/generated_image 只读。**confirm_casting 有副作用**：它用 GET 动词改变了远端状态，会使该材质被本次制作采用。它同样需要 idempotency_key，且不要重试。**remove 会不可恢复地删除一个父资产**（`DELETE /aigc/asset/removeAsset/{id}`，带 scriptId 与 isParent=1）：资产与其媒体版本会被移除，引用它的镜头匹配与已生成视频不会因此重建。**如果只是想取消\"正式选用\"，不要用 remove** —— 那是一个不同的动作。**create_folder / move / rename 会改变控制台里的组织方式**（都在 `/aigc/*` 上真实写入）：create_folder 建一个类别库里的文件夹，同名同级已存在时直接报告、不发请求；move 把材质行移进文件夹，目标文件夹不在该库里时同样只报告；rename 改资产的显示名称。三者都需要 idempotency_key，都不改图片、不改 id、不换类别。**批量改名或搬家前必须先取得用户明确同意**：这些是用户已经在控制台里看到的名字和位置。**upload_reference 免费**：把本地参考图（jpg/jpeg/png/webp）按剧变前端自身的上传配置送到它的对象存储，返回 HTTPS material_url —— gpt-image-2 的参考图只接受 URL。两条边必须是 16 的倍数：已合规的文件原样上传，不合规时调用本机 ffmpeg 重编码（可用 DSH_JUBIAN_FFMPEG/FFMPEG_PATH 指定二进制）；本机找不到 ffmpeg 时返回 alignment_required 并给出应有的尺寸，绝不上传不合规的图片。写方法必须提供 idempotency_key：同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"get",
					"list",
					"materials",
					"generated_image",
					"confirm_casting",
					"register",
					"remove",
					"upload_reference",
					"create_folder",
					"move",
					"rename"
				],
				description: "get=单个资产（含 is_local/status）；list=项目资产分页；materials=主体设定材质；generated_image=该资产的生成图 URL；confirm_casting=确认出演（有副作用）；register=按指定类别新建一条资产，只引用已有图片、不生成新图（有副作用）；remove=删除一个父资产（不可恢复）；upload_reference=上传本地参考图并取回 material_url（免费）；create_folder=在某个类别库里建文件夹；move=把资产移动进文件夹；rename=给资产改名。"
			},
			script_id: ARGS.script_id,
			asset_id: ARGS.asset_id,
			material_id: ARGS.material_id,
			page_num: ARGS.page_num,
			page_size: ARGS.page_size,
			idempotency_key: ARGS.idempotency_key,
			image_path: ARGS.image_path,
			folder_name: ARGS.folder_name,
			parent_id: ARGS.parent_id,
			asset_scope_type: ARGS.asset_scope_type,
			root_category_type: ARGS.root_category_type,
			material_ids: ARGS.material_ids,
			target_folder_id: ARGS.target_folder_id,
			asset_name: ARGS.asset_name,
			episode: ARGS.episode,
			asset_category: ARGS.asset_category,
			asset_type: ARGS.asset_type,
			asset_url: ARGS.asset_url
		},
		output: OUTPUT,
		execute: guarded("jubian_asset", (args) => assetMethod(client, ledger, args, { naming }))
	}));
	ctx.tools.register(defineTool({
		name: "jubian_organize",
		description: "只读、免费的资产组织视图：把剧变项目按「集数 → 类别」列出（每集用到哪些角色/场景/道具，各自的 asset_id、material_id 与状态），并做两份审计——不符合 `EP{两位集数}｜{类别}｜{名称}` 规范的远端名称，以及 assetType 与自身名字或清单声明不一致的资产（历史遗留的类别错放）。同时读出个人资产库里每个类别的文件夹树。**它只读：不重命名、不移动、不改动任何远端资产**，结果同时写一份本地索引文件。要改，用 jubian_asset 的 create_folder / move / rename，且批量操作前先取得用户同意。",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: ["index"],
				description: "index=按集数与类别输出组织视图，并写本地索引文件。"
			},
			script_id: {
				...ARGS.script_id,
				required: true
			},
			project_dir: {
				...ARGS.project_dir,
				required: true
			}
		},
		output: OUTPUT,
		execute: guarded("jubian_organize", (args) => organizeMethod(client, args, {
			naming,
			...config.assetIndexPath === void 0 ? {} : { indexPath: config.assetIndexPath }
		}))
	}));
	ctx.tools.register(defineTool({
		name: "jubian_model",
		description: "免费配置现有分镜的视频模型与分辨率。preview 只读实时目录和分镜，按明确范围写本地冻结计划，返回每项 before/after 与 fingerprint；不 PUT、不生成。scope=storyboards 使用远端 storyboard_ids，episodes 使用远端 episode_ids（不是集号），project 仅包含当前项目已有分镜。apply 必须先取得用户对范围和配置的同意，使用 preview_path 与 idempotency_key=fingerprint。写前校验全部目标、成员和目录，每项再即时回读；只改 modelConfig 模型字段，所有 PUT 强制 isGenerate=0，保留提示词、资产身份和顺序、非模型设置，回读核验。未提供的设置保留，不会默认切换模型；更换模型未指定 platformId 时要求目录唯一匹配，否则拒绝。项目未来默认值和已生成媒体不变。错误或超时立即停止剩余项并逐项报告；同一计划不会重发或续写，先回读对账，不要换 key 盲目重试。",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: ["preview", "apply"],
				description: "preview=只读预览并落冻结计划；apply=应用用户批准的计划（免费，不生成）。"
			},
			project_dir: {
				type: "string",
				required: true,
				description: "含 project_config.json 的项目目录。"
			},
			script_id: {
				type: "number",
				required: true,
				description: "必须与 project_config.json 及所有目标一致的远端项目 ID。"
			},
			scope: {
				type: "string",
				enum: [
					"storyboards",
					"episodes",
					"project"
				],
				description: "preview 必填：已有分镜的明确范围。"
			},
			storyboard_ids: {
				type: "array",
				items: { type: "number" },
				description: "storyboards 范围必填：精确远端分镜 ID，不能重复。"
			},
			episode_ids: {
				type: "array",
				items: { type: "number" },
				description: "episodes 范围必填：精确远端 episodeId，不是显示集号。"
			},
			changes: {
				type: "object",
				additionalProperties: false,
				description: "preview 必填：至少一项。未指定字段保留，目录中不支持或不唯一时拒绝。",
				properties: {
					modelId: {
						type: "string",
						description: "账户视频目录中的精确模型 ID，不接受别名或默认替换。"
					},
					platformId: {
						type: "string",
						description: "明确指定的平台；换模型时省略则要求唯一匹配。"
					},
					ratio: {
						type: "string",
						description: "目录支持的比例，例如 9:16。"
					},
					resolution: {
						type: "string",
						description: "目录支持的分辨率，例如 720p、1080p。"
					},
					genType: {
						type: "number",
						description: "目录支持的生成类型。"
					},
					duration: {
						type: "number",
						description: "模型允许的整数秒数，包含末尾自然收束。"
					},
					genNum: {
						type: "number",
						description: "目录支持的生成数量。"
					}
				}
			},
			preview_path: {
				type: "string",
				description: "apply 必填：preview 返回的冻结计划路径。"
			},
			idempotency_key: {
				type: "string",
				description: "apply 必填：必须等于计划 fingerprint；同计划永不重发。"
			}
		},
		output: OUTPUT,
		execute: guarded("jubian_model", (args) => modelMethod(client, ledger, args))
	}));
	ctx.tools.register(defineTool({
		name: "jubian_storyboard",
		description: "剧变（Jubian）分镜查询与提交。get/create/save 免费（create/save 强制 isGenerate=0）。**generate、erase_subtitle 与 submit_video 会真实计费且不可撤销**。generate 先读当前分镜快照再把 isGenerate 置 1 提交，因此必须同时给出 content_duration_ms，且它必须与该分镜已保存的时长一致，否则会在发请求前失败。**主体视频的唯一正常通道是 select_assets(isGenerate=0) → prepare_video → submit_video**：select_assets 把选定资产写进分镜，永远强制 isGenerate=0（免费），PUT 后回读身份/URL/名称/顺序；prepare_video 只读实时分镜、主体设定与模型目录，保留已存 modelId/比例/分辨率/时长，按精确模型 ID 解析当前目录；不支持、匹配不唯一或超过该模型时长上限时拒绝，不自动换模型，在 <project_dir>/video_tasks/ 原子写一份 *.storyboard-native.prepared.json，不 PUT、不创建任务、不收费；submit_video 的 idempotency_key 必须等于该 preview 自带的 fingerprint，PUT 前做远端任务全量双快照对账，确认无冲突后最多执行一次 PUT /aigc/storyboard（isGenerate=1），随后第二次快照回读每个子项的 assetId/materialName/imageUrl 与顺序；身份缺失是终态 subject_identity_lost，超时/5xx/连接中断/缺 task ID 只进入对账状态，绝不自动二次 PUT。**禁止 direct POST /admin/aigc/video/task/create**（任务 335470 因此丢失主体身份）；storyboard PUT 创建的 335343 保留了全部七项身份。**erase_subtitle 必填 task_id、model_id 与画面尺寸**（script_id 从任务行读取）：源身份从父任务与子结果读，擦除矩形按提供方的默认比例从画面尺寸推导，不需要也不应该由调用方画框。model_id 没有默认值，省略会在发任何请求之前报 INVALID_ARGUMENT，不会静默替你挑一个模型。它与转高清一样是异步的，提交后不要干等——先做别的，之后用 subtasks 回读判断。写方法必须提供 idempotency_key：同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"get",
					"create",
					"save",
					"generate",
					"select_assets",
					"prepare_video",
					"submit_video",
					"erase_subtitle"
				],
				description: "get=读分镜（含 model_config 与素材键）；create=用调用方给定的请求体新建；save=存为不生成；generate=提交生成（计费）；select_assets=写入选定资产（免费，强制 isGenerate=0）；prepare_video=只读准备并落 preview（免费）；submit_video=按 preview 提交一次（计费、异步）；erase_subtitle=去字幕（计费、异步）。"
			},
			storyboard_id: ARGS.storyboard_id,
			content_duration_ms: ARGS.content_duration_ms,
			task_id: ARGS.task_id,
			script_id: ARGS.script_id,
			model_id: ARGS.model_id,
			task_name: ARGS.task_name,
			episode: ARGS.episode,
			package_number: ARGS.package_number,
			video_width: ARGS.video_width,
			video_height: ARGS.video_height,
			subtitle_box: ARGS.subtitle_box,
			body: ARGS.body,
			body_path: ARGS.body_path,
			idempotency_key: ARGS.idempotency_key,
			selections: ARGS.selections,
			project_dir: ARGS.project_dir,
			preview_path: ARGS.preview_path
		},
		output: OUTPUT,
		execute: guarded("jubian_storyboard", (args) => storyboardMethod(client, ledger, args, { naming }))
	}));
	ctx.tools.register(defineTool({
		name: "jubian_video",
		description: "剧变（Jubian）视频任务查询与图片生成。task/tasks/subtasks 只读（subtasks 用 POST 承载查询体，仍然只读；它返回成片 videoUrl 与字幕像素框）。**image_generate 会真实计费且不可撤销**：生成或重生成一张主体资产图；给了 parent_asset_id 就是重生成（PUT），否则新建（POST）。它只在同一个 idempotency_key 下发送一次，并在受理后回读该资产直到 hsAssetStatus 变为 Active，然后返回 material_id（confirm_casting 需要它）与 image_url。返回里的 asset_status 说明回读结论：active 才是拿到图（此时才可落盘/审核）；timeout 表示受理已计费但资产尚未 Active，不要换 key 重投，稍后用 jubian_asset get/generated_image 续读；failed 表示提供方判失败；unverified 表示没能确认资产，先回读 jubian_asset list。账户目录里 gpt-image-2 可能有多行（不同平台、不同单价）；插件不替你挑平台：没有锁定行而目录多于一行时，请求体构造阶段就会报错并列出全部候选行（platformId、standardId、单价）。锁定行由人在 Web 设置的「短剧 → 资产图生成通道」里选，或由部署在插件配置里给 imagePlatformId/imageStandardId；遇到这个报错时把候选念给用户，请他在设置里选一行，不要自己挑。**upscale 会真实计费（SeedVR2 视频高清，1 元/条）**：把成片转成 1080p。SD2.5 默认使用原片，不自动提交或等待高清；任何模型都不能仅因 needs_upscale=true 自动付费。仅在用户明确要求或授权具体高清处理时调用 upscale（包括 SD2.5）。普通导出尺寸与真实源分辨率须分别如实报告；本地缩放不等于恢复源画质。它是异步的，实测要十几分钟，提交后立刻返回、绝不等待——先做别的，之后用 subtasks 回读 hd_count / last_task_type / resolution 判断是否转好。**retry 是服务端状态变更**：只在父子任务全部终止失败、没有结果 URL、也没有真实费用时才会发出；重试响应异常时不要盲目重提，先回读父任务与生成子素材。写方法必须提供 idempotency_key：同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）。超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"task",
					"tasks",
					"subtasks",
					"unresolved",
					"image_generate",
					"upscale",
					"retry"
				],
				description: "task=单个任务（含 cost 观测）；tasks=项目任务分页；subtasks=任务的子结果（成片 URL、字幕框、阶段、分辨率与 needs_upscale）；unresolved=只读本地账本，列出没有确定结果的写入（进程重启后先做这一步，按返回的 next 逐笔对账，不要换 key 重发）；image_generate=生成图片（计费）；upscale=转高清（计费、异步）；retry=重试终止失败且未计费的任务。"
			},
			task_id: ARGS.task_id,
			script_id: ARGS.script_id,
			page_num: ARGS.page_num,
			delivery_resolution: ARGS.delivery_resolution,
			asset_name: ARGS.asset_name,
			asset_type: ARGS.asset_type,
			prompt: ARGS.prompt,
			references: ARGS.references,
			parent_asset_id: ARGS.parent_asset_id,
			episode: ARGS.episode,
			asset_category: ARGS.asset_category,
			package_number: ARGS.package_number,
			task_name: ARGS.task_name,
			idempotency_key: ARGS.idempotency_key
		},
		output: OUTPUT,
		execute: guarded("jubian_video", (args) => videoMethod(client, ledger, args, {
			image: image(),
			naming
		}))
	}));
	ctx.tools.register(defineTool({
		name: "jubian_watch",
		description: "只读后台观察已受理的剧变操作，立即返回 job_id；task_id 必须是本次生成/转高清/去字幕操作的任务 ID，不是源视频任务 ID。只读同一任务及其完整子结果，严格核对身份、阶段和成功状态；旧 URL 或 hdCount 不代表本次完成。完成后由 jobs 通知，用 job_output 取结果；job_kill 只停观察，不取消提供方操作。进程重启不恢复，超时失败不重投收费请求。提供方完成不等于视觉审核通过：结果仍需抽帧、音频和交付分辨率检查。",
		parameters: {
			task_id: {
				type: "integer",
				required: true,
				description: "已受理的本次操作任务 ID（正安全整数），不是源任务 ID。"
			},
			stage: {
				type: "string",
				required: true,
				enum: [
					"generate",
					"upscale",
					"erase_subtitle"
				],
				description: "本次操作的阶段，必须与任务类型及全部输出一致。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					job_id: {
						type: "string",
						required: true
					},
					task_id: {
						type: "integer",
						required: true
					},
					stage: {
						type: "string",
						enum: [
							"generate",
							"upscale",
							"erase_subtitle"
						],
						required: true
					},
					status: {
						type: "string",
						enum: ["running"],
						required: true
					}
				}
			},
			render: OUTPUT.render
		},
		execute: async (args, exec) => {
			const input = watchArgs(args);
			const jobs = ctx.get("jobs");
			if (!jobs) throw new Error("jubian_watch requires a jobs provider and job controller; other Jubian tools remain available");
			if (!exec.agent) throw new Error("jubian_watch requires an owning Agent for completion delivery");
			return {
				job_id: jobs.start({
					kind: "jubian",
					owner: exec.agent,
					label: `Jubian ${input.stage} operation ${input.task_id}`,
					run: () => watchJob(client, input, watchConfig)
				}),
				...input,
				status: "running"
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "jubian_media",
		description: "把剧变（Jubian）CDN 上的媒体下载到本地文件，返回本地路径、字节数与 sha256。不产生费用、不需要凭证（该 CDN 是公开的）。下载后请用你自己的看图工具（如 read_image）或抽帧工具读取该路径——本工具不会把图片或视频内容放进返回值。",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: ["download"],
				description: "download=从 media_url 下载到 output_path。"
			},
			media_url: {
				...ARGS.media_url,
				required: true
			},
			media_kind: {
				...ARGS.media_kind,
				required: true
			},
			output_path: {
				...ARGS.output_path,
				required: true
			}
		},
		output: OUTPUT,
		execute: guarded("jubian_media", (args) => mediaMethod(args))
	}));
}
//#endregion
export { JubianImageRoutes, JubianToken, apply, inject, name, pinnedImageSelection, workspacePipelineToken };
