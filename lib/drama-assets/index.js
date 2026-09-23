import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { JUBIAN_TOKEN_REF, JubianClient, JubianError } from "@deepseek-ai/dsh-jubian";
import { randomBytes } from "node:crypto";
import { readAssetList, readMaterialList } from "@deepseek-ai/dsh-jubian-api";
//#region lib/types/manifest.js
/**
* The project's own `assets_manifest.json`, read as the comparison's local side.
*
* The manifest is a durable-file boundary, so it is validated where it is read:
* the document, its two record arrays, its `script_id`, and every
* `jubian_asset_id`. The id is where the pipeline's own tools disagree with
* themselves — `_tools/asset_reconcile.py` counts only integer ids and this
* module keeps that rule, because an id spelled as a string is a manifest defect
* this comparison must report as missing rather than silently accept as covered.
*
* @module @deepseek-ai/dsh-tool-drama-assets/manifest
*/
/** The one file this package reads from a project. */
const MANIFEST_FILE = "assets_manifest.json";
/** Read one JSON object, or throw with the path that failed. */
function objectAt(value, detail) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JubianError("CONTRACT_CHANGED", detail);
	return value;
}
/** Read one record array, treating an absent one as empty. */
function rowsAt(value) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new JubianError("CONTRACT_CHANGED", "清单里 items / lead_readonly_records 必须是数组");
	return value.map((row) => objectAt(row, "清单里有记录不是 JSON 对象"));
}
/** The integer id one manifest record declares, or null when it declares none. */
function assetIdOf(record) {
	const value = record["jubian_asset_id"];
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
/**
* Read one project's manifest.
* @param projectDir - Resolved project directory holding `assets_manifest.json`.
* @returns The project id and the two record arrays, in file order.
* @throws {JubianError} `CONTRACT_CHANGED` when the file is unreadable, is not JSON, is not an object,
*   carries no integer `script_id`, or carries a record array that is not an array of objects.
*/
async function readManifest(projectDir) {
	const path = join(projectDir, MANIFEST_FILE);
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new JubianError("CONTRACT_CHANGED", `${path} 读不到：project_dir 必须是含 ${MANIFEST_FILE} 的项目根目录`);
	}
	let document;
	try {
		document = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		throw new JubianError("CONTRACT_CHANGED", `${path} 不是合法 JSON`);
	}
	const record = objectAt(document, `${path} 顶层不是 JSON 对象`);
	const scriptId = record["script_id"];
	if (typeof scriptId !== "number" || !Number.isSafeInteger(scriptId)) throw new JubianError("CONTRACT_CHANGED", `${path} 缺少整数 script_id：远端读什么项目由它决定，不能在本地兜一个默认值`);
	return {
		script_id: scriptId,
		items: rowsAt(record["items"]),
		lead_readonly_records: rowsAt(record["lead_readonly_records"])
	};
}
/**
* Every asset id the manifest declares, from `items` and `lead_readonly_records`.
* @param manifest - A manifest read by {@link readManifest}.
* @returns The declared ids; a record without an integer id contributes nothing.
*/
function manifestAssetIds(manifest) {
	const ids = /* @__PURE__ */ new Set();
	for (const record of [...manifest.items, ...manifest.lead_readonly_records]) {
		const id = assetIdOf(record);
		if (id !== null) ids.add(id);
	}
	return ids;
}
//#endregion
//#region lib/types/remote.js
/**
* The two remote reads the comparison is made of, over the shared Jubian
* transport.
*
* `readAssetList` and `readMaterialList` validate each page and map it to the
* fields a selection decision needs. This comparison needs fields those mappings
* do not carry: the asset row's `delFlag` decides whether the asset still exists,
* and the material row's `createTime` is part of the evidence the pipeline's own
* report script reads. Both readers stay the authority on what a page is — a page
* they reject fails the call — and the extra provider fields are read from the
* rows they accepted.
*
* Every page is read, not just the first: a project whose assets outgrew one page
* would otherwise be reconciled against a fraction of itself, which is the same
* class of quiet under-reporting this comparison exists to catch.
*
* @module @deepseek-ai/dsh-tool-drama-assets/remote
*/
/** Page size every read asks for: the provider's own documented maximum. */
const PAGE_SIZE = 1e3;
/** One provider text field, or undefined for a value that is not text. */
function textOf(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
/** One provider `assetName` field, read under either spelling the provider uses. */
function nameOf(row) {
	return textOf(row["assetName"]) ?? textOf(row["name"]);
}
/** One provider `assetType` field, or undefined for a value that is not a number. */
function typeOf(row) {
	return typeof row["assetType"] === "number" ? row["assetType"] : void 0;
}
/**
* Read one accepted asset row's comparison fields.
* @param mapped - The row as {@link readAssetList} mapped it.
* @param raw - The same row as the provider sent it.
* @returns The asset's id and the optional provider fields the evidence quotes.
*/
function assetOf(mapped, raw) {
	return {
		asset_id: mapped["asset_id"],
		del_flag: textOf(raw["delFlag"]),
		name: nameOf(raw),
		asset_type: typeOf(raw),
		url: textOf(raw["url"]),
		create_time: textOf(raw["createTime"])
	};
}
/**
* Read one accepted material row's comparison fields.
* @param mapped - The row as {@link readMaterialList} mapped it.
* @param raw - The same row as the provider sent it.
* @returns The material's id and the optional provider fields the evidence quotes.
*/
function materialOf(mapped, raw) {
	return {
		material_id: mapped["material_id"],
		asset_id: mapped["asset_id"] ?? null,
		name: nameOf(raw),
		asset_type: typeOf(raw),
		is_used: raw["isUsed"] === 1,
		hs_asset_status: textOf(raw["hsAssetStatus"]),
		url: textOf(raw["assetUrl"]),
		create_time: textOf(raw["createTime"])
	};
}
/**
* Read every page of one provider list endpoint.
*
* The reader's mapped rows are the provider's rows by index, so a mapped row
* carries its own raw row alongside it and no field is ever read from a page the
* reader did not accept.
* @param client - Jubian transport.
* @param path - The endpoint's path and query; `pageNum` and `pageSize` are added per page.
* @param read - The reader that validates one page and maps its rows.
* @param reduce - Maps one accepted row, its reader's mapping and its raw row, to the comparison fields.
* @returns Every accepted row of every page, in provider order.
*/
async function readPages(client, path, read, reduce) {
	const collected = [];
	let pageNum = 1;
	for (;;) {
		const response = await client.request({
			method: "GET",
			path: `${path}&pageNum=${pageNum}&pageSize=${PAGE_SIZE}`
		});
		const page = read(response.data);
		const raw = response.data.rows;
		collected.push(...page.rows.map((mapped, index) => reduce(mapped, raw[index])));
		if (page.rows.length < PAGE_SIZE || collected.length >= page.total) return collected;
		pageNum += 1;
	}
}
/**
* Read every asset the remote project holds, removed rows included.
*
* The `delFlag` filter belongs to the comparison rather than here: a removed
* asset is still a row this read returns, and only the comparison knows that a
* removed asset is not an asset.
* @param client - Jubian transport.
* @param scriptId - Project to list.
* @returns The project's assets with their comparison fields.
*/
async function readRemoteAssets(client, scriptId) {
	return await readPages(client, `/aigc/asset/list?scriptId=${scriptId}`, readAssetList, assetOf);
}
/**
* Read every material of the remote project's subject setting.
*
* The provider offers an `isUsed=1` filter and this read does not use it: the
* comparison must keep the used rows and the alive rows apart, and a filter
* applied here would make the two counts one fact.
* @param client - Jubian transport.
* @param scriptId - Project to list.
* @returns The project's materials with their comparison fields.
*/
async function readRemoteMaterials(client, scriptId) {
	return await readPages(client, `/aigc/material/list?scriptId=${scriptId}`, readMaterialList, materialOf);
}
//#endregion
//#region lib/types/reconcile.js
/**
* The comparison itself: what the remote project already contains against what
* the manifest records.
*
* This is a port of the pipeline's `_tools/asset_reconcile.py`, and the port is
* field-for-field on purpose. Its evidence file is read by two other programs —
* the workspace's `_tools/asset_reconcile_report.py` and the host's
* paid-generation gate — so a name, a type or a verdict that drifts is a silent
* failure in a check whose whole job is to stop a silent failure.
*
* Three judgements live here, and each is the pipeline's own, not this package's:
* a remote asset exists when `asset/list` returned it with `delFlag == "0"`; a
* remote asset is in use when `material/list` carried `isUsed == 1` and
* `hsAssetStatus == "Active"`; and an unregistered asset releases a paid
* generation only when a person registered it or ignored it with a reason.
*
* @module @deepseek-ai/dsh-tool-drama-assets/reconcile
*/
/** Why a dangling entry is reported, in the pipeline's own words. */
const DANGLING_WHY = "清单里有这条记录，远端 asset/list 里没有它（可能在别的 scriptId 或已被删）";
/** The directory the pipeline's evidence lives in, below one project root. */
const PROBE_DIR = "_probe";
/** The evidence file the host gate reads, below {@link PROBE_DIR}. */
const EVIDENCE_FILE = "asset-reconcile.json";
/** China Standard Time, the zone every stamp this package writes carries. */
const CN_OFFSET = "+08:00";
const CN_OFFSET_MS = 480 * 60 * 1e3;
/** The statuses a disposition may hold that release a paid generation. */
const RELEASING = new Set(["registered", "ignored"]);
/**
* The paid-generation policy this evidence records.
*
* These are protocol constants, not deployment choices: they describe the route
* the pipeline buys on, and the report exists so the host gate reads the same
* numbers the pipeline priced.
*/
const POLICY = {
	image_channel: "KU_AI",
	image_unit_price_cny: .12,
	max_attempts_per_asset: 3,
	worst_case_cny_per_asset: .36,
	cross_project_reuse: "手动：先跑 jubian-asset-library 技能检索，结论写进本文件的 cross_project_note"
};
/**
* The current moment as the pipeline stamps it: ISO seconds with the `+08:00` offset.
* @param now - The instant to stamp; defaults to the current one.
* @returns The stamp the evidence file carries.
*/
function chinaStamp(now = /* @__PURE__ */ new Date()) {
	return `${new Date(now.getTime() + CN_OFFSET_MS).toISOString().slice(0, 19)}${CN_OFFSET}`;
}
/**
* The evidence file one project holds.
* @param projectDir - Resolved project directory.
* @returns The absolute path of `_probe/asset-reconcile.json` below it.
*/
function evidencePath(projectDir) {
	return join(projectDir, PROBE_DIR, EVIDENCE_FILE);
}
/**
* One remote material's evidence row, filled from the material and then from the alive asset row.
*
* The material row answers first for every field, and the asset row is only the
* fallback: a material that names its own category keeps it even when the asset
* row disagrees. A field neither row carries is written as null, which is what
* the pipeline's own report prints for it.
* @param assetId - The asset the material belongs to.
* @param material - The used material row.
* @param asset - The alive asset row for the same id, absent when the asset was removed.
* @returns The row the evidence lists.
*/
function unregisteredItem(assetId, material, asset) {
	return {
		asset_id: assetId,
		material_id: material.material_id,
		name: material.name ?? asset?.name ?? null,
		asset_type: material.asset_type ?? asset?.asset_type ?? null,
		is_used: 1,
		hs_asset_status: "Active",
		url: material.url ?? asset?.url ?? null,
		create_time: material.create_time ?? asset?.create_time ?? null
	};
}
/** The ids of the assets the remote project still holds: rows carrying `delFlag == "0"`. */
function aliveIds(assets) {
	return new Set(assets.filter((asset) => asset.del_flag === "0").map((asset) => asset.asset_id));
}
/**
* The used-and-active materials of assets the remote project still holds, one per
* asset id, first row wins.
*
* A removed asset stays out even when a material still points at it: the pipeline's
* rule pairs `isUsed == 1` with `hsAssetStatus == "Active"` on a project whose asset
* list still carries the row, and an asset with `delFlag` set is not one.
* @param materials - Every material of the project's subject setting.
* @param alive - The asset ids the project still holds.
* @returns The used material per used asset id.
*/
function usedByAsset(materials, alive) {
	const used = /* @__PURE__ */ new Map();
	for (const material of materials) {
		if (material.asset_id === null || !alive.has(material.asset_id)) continue;
		if (material.is_used && material.hs_asset_status === "Active" && !used.has(material.asset_id)) used.set(material.asset_id, material);
	}
	return used;
}
/** The manifest records whose asset id the remote project does not hold. */
function danglingOf(manifest, alive) {
	const dangling = [];
	for (const record of [...manifest.items, ...manifest.lead_readonly_records]) {
		const id = record["jubian_asset_id"];
		if (typeof id !== "number" || !Number.isSafeInteger(id) || alive.has(id)) continue;
		const stableId = record["stable_id"];
		const name = record["name"];
		dangling.push({
			stable_id: typeof stableId === "string" ? stableId : null,
			jubian_asset_id: id,
			name: typeof name === "string" ? name : null,
			why: DANGLING_WHY
		});
	}
	return dangling;
}
/**
* The disposition map this run carries: the previous one, plus a pending entry per
* unregistered asset, plus an automatic `registered` for every asset the manifest
* now records.
*
* The automatic entry is what closes the loop: an asset a person registered in
* the manifest is recognized on the next run, and the note they had written is
* kept rather than overwritten.
* @param unregistered - This run's unregistered rows.
* @param known - Every asset id the manifest declares.
* @param previous - The dispositions the previous evidence carried.
* @returns Every disposition, keyed by asset id as text.
*/
function carryDispositions(unregistered, known, previous) {
	const dispositions = { ...previous };
	for (const item of unregistered) {
		const key = String(item.asset_id);
		dispositions[key] ??= {
			status: "pending",
			note: ""
		};
	}
	for (const [key, disposition] of Object.entries(dispositions)) if (known.has(Number(key))) dispositions[key] = {
		status: "registered",
		note: disposition.note
	};
	return dispositions;
}
/**
* The two dispositions that still refuse a paid generation: no decision yet, and
* an `ignored` decision that states no reason.
* @param dispositions - Every disposition the evidence carries.
* @returns The blocking asset ids and the ignored ids whose note is empty.
*/
function deriveVerdicts(dispositions) {
	const blocking = [];
	const ignoredWithoutNote = [];
	for (const [key, disposition] of Object.entries(dispositions)) {
		if (!RELEASING.has(disposition.status)) blocking.push(Number(key));
		if (disposition.status === "ignored" && !disposition.note.trim()) ignoredWithoutNote.push(Number(key));
	}
	return {
		blocking,
		ignored_without_note: ignoredWithoutNote
	};
}
/**
* The unregistered rows, in ascending asset id order.
*
* The evidence file's `unregistered` list is read positionally by the pipeline's
* own report and its order is part of what a reader compares between runs, so the
* order is explicit rather than left to the map's own iteration order.
* @param used - The used material per used asset id.
* @param known - Every asset id the manifest declares.
* @param alive - Every alive asset row, by id.
* @returns One evidence row per used asset the manifest does not record.
*/
function unregisteredOf(used, known, alive) {
	return [...used.keys()].filter((id) => !known.has(id)).sort((left, right) => left - right).map((id) => unregisteredItem(id, used.get(id), alive.get(id)));
}
/** Whether a report whose verdicts are known may release a paid asset creation. */
function isReady(blocking, ignoredWithoutNote) {
	return blocking.length === 0 && ignoredWithoutNote.length === 0;
}
/**
* Compare one project's remote assets against its manifest and return the report.
*
* Reading only: both remote calls are the provider's own list endpoints.
* @param client - Jubian transport.
* @param projectDir - Resolved project directory holding the manifest.
* @param previous - The previous evidence, whose dispositions and cross-project note are carried forward.
* @param now - The instant to stamp the report with; defaults to the current one.
* @returns The evidence document, without having written it.
* @throws {JubianError} `CONTRACT_CHANGED` for a manifest or a remote page this comparison cannot read.
*/
async function buildReport(client, projectDir, previous, now = /* @__PURE__ */ new Date()) {
	const manifest = await readManifest(projectDir);
	const known = manifestAssetIds(manifest);
	const assets = await readRemoteAssets(client, manifest.script_id);
	const materials = await readRemoteMaterials(client, manifest.script_id);
	const alive = aliveIds(assets);
	const used = usedByAsset(materials, alive);
	const unregistered = unregisteredOf(used, known, new Map(assets.filter((asset) => alive.has(asset.asset_id)).map((asset) => [asset.asset_id, asset])));
	const dispositions = carryDispositions(unregistered, known, previous.disposition ?? {});
	const { blocking, ignored_without_note: ignoredWithoutNote } = deriveVerdicts(dispositions);
	const dangling = danglingOf(manifest, alive);
	return {
		script_id: manifest.script_id,
		ran_at: chinaStamp(now),
		source: {
			asset_list_rows: assets.length,
			material_list_rows: materials.length,
			remote_alive: alive.size,
			remote_used: used.size
		},
		manifest: {
			items: manifest.items.length,
			lead_readonly_records: manifest.lead_readonly_records.length,
			asset_ids: known.size
		},
		matched: used.size - unregistered.length,
		unregistered,
		dangling,
		disposition: dispositions,
		blocking,
		ignored_without_note: ignoredWithoutNote,
		ready: isReady(blocking, ignoredWithoutNote),
		policy: POLICY,
		cross_project_note: previous.cross_project_note ?? ""
	};
}
/** Write one text file atomically beside its destination directory. */
async function writeAtomic(path, body) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, body, "utf8");
	await rename(temporary, path);
}
/** Serialize one report as the evidence file spells it: two-space indent, no ASCII escaping, one trailing newline. */
function evidenceText(report) {
	return `${JSON.stringify(report, null, 2)}\n`;
}
/**
* Read the evidence a project already holds, or an empty document when it holds none.
*
* An unreadable evidence file is a defect rather than an empty one: a comparison
* that treated it as absent would silently drop every disposition a person had
* already written.
* @param projectDir - Resolved project directory.
* @returns The parsed evidence, or an empty object when there is no file.
* @throws {JubianError} `CONTRACT_CHANGED` when the file exists but is not a JSON object.
*/
async function readEvidence(projectDir) {
	const path = evidencePath(projectDir);
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {};
	}
	let document;
	try {
		document = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		throw new JubianError("CONTRACT_CHANGED", `${path} 不是合法 JSON`);
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) throw new JubianError("CONTRACT_CHANGED", `${path} 顶层不是 JSON 对象`);
	return document;
}
/**
* Reconcile one project and write the evidence the host gate reads.
* @param client - Jubian transport.
* @param projectDir - Resolved project directory holding `assets_manifest.json`.
* @param now - The instant to stamp the report with; defaults to the current one.
* @returns The written report.
* @throws {JubianError} `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this cannot read.
*/
async function reconcileProject(client, projectDir, now = /* @__PURE__ */ new Date()) {
	const report = await buildReport(client, projectDir, await readEvidence(projectDir), now);
	await writeAtomic(evidencePath(projectDir), evidenceText(report));
	return report;
}
/**
* Record one person's disposition of one unregistered asset and recompute the verdicts.
*
* This touches no remote endpoint: the comparison it edits was made when the
* evidence was written, and re-running it here would spend a network round trip
* on a decision a person already made.
* @param projectDir - Resolved project directory.
* @param assetId - The unregistered asset the disposition is about.
* @param status - `registered` or `ignored`.
* @param note - Why the asset is not needed; required and non-empty for `ignored`.
* @returns The evidence as written, minus the comparison fields this call does not recompute.
* @throws {JubianError} `INVALID_ARGUMENT` for a missing or unusable argument,
*   `CONTRACT_CHANGED` when the existing evidence cannot be read.
*/
async function disposeAsset(projectDir, assetId, status, note) {
	if (!Number.isSafeInteger(assetId) || assetId < 1) throw new JubianError("INVALID_ARGUMENT", `asset_id 必须是正整数，收到 ${String(assetId)}`);
	if (status !== "registered" && status !== "ignored") throw new JubianError("INVALID_ARGUMENT", `status 必须是 registered 或 ignored，收到 ${String(status)}`);
	if (status === "ignored" && !note.trim()) throw new JubianError("INVALID_ARGUMENT", "status=ignored 必须带非空 note：写清为什么这个资产不需要");
	const evidence = await readEvidence(projectDir);
	const dispositions = { ...evidence.disposition ?? {} };
	dispositions[String(assetId)] = {
		status,
		note
	};
	const { blocking, ignored_without_note: ignoredWithoutNote } = deriveVerdicts(dispositions);
	const updated = {
		...evidence,
		disposition: dispositions,
		blocking,
		ignored_without_note: ignoredWithoutNote,
		ready: isReady(blocking, ignoredWithoutNote)
	};
	await writeAtomic(evidencePath(projectDir), evidenceText(updated));
	return updated;
}
/**
* The project directory one call names, as an absolute path.
* @param projectDir - The argument as the model passed it.
* @returns The resolved project directory.
* @throws {JubianError} `INVALID_ARGUMENT` when the argument is missing or blank.
*/
function resolveProjectDir(projectDir) {
	const trimmed = projectDir?.trim();
	if (!trimmed) throw new JubianError("INVALID_ARGUMENT", `project_dir 必填：含 ${MANIFEST_FILE} 的项目根目录绝对路径`);
	return resolve(trimmed);
}
//#endregion
//#region lib/types/index.js
/**
* `drama_assets`: the short-drama pipeline's pre-spend asset reconciliation, as
* one model-facing tool.
*
* The pipeline shipped this twice: a skill told the model to run
* `_tools/asset_reconcile.py` before spending money, and the host's paid-call
* gate read the evidence that script wrote. The gate is what actually refuses a
* call, so the comparison it depends on must not be a script the product's users
* need Python to run. This package owns the comparison; the gate, the evidence
* file's format, and the verdict it reads are unchanged.
*
* The comparison answers a question the manifest cannot: the manifest records
* what this pipeline generated, while the remote project holds every asset that
* was ever selected there. A project held a formal asset from three weeks earlier
* that no manifest row mentioned, a model read the manifest as the inventory, and
* two paid generations of an asset that already existed were bought. So this tool
* reads both sides, writes one evidence file, and never writes anything remote.
*
* @module @deepseek-ai/dsh-tool-drama-assets
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "tool-drama-assets";
/** The registries this plugin contributes `drama_assets` to. */
const inject = ["tools", "credentials"];
/** The workspace-relative secret file the pipeline skills and `tool-jubian` already use. */
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
				const key = match?.[1];
				const value = match?.[2];
				if (key === void 0 || value === void 0) continue;
				values.set(key, value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
			}
			return values.get("JUBIANAI_ADMIN_TOKEN") || values.get("JUBIANAI_TOKEN") || "";
		} catch {}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return "";
}
/**
* The reason text for the two verdicts, in the pipeline's own words.
*
* Only the two lists are read: a report reaching here with either of them non-empty
* and `ready: true` is not a state this package produces, so there is no third
* message for it.
* @param report - The two verdict lists the evidence carries.
* @returns The Chinese reason the host gate reports for the same state.
*/
function readyReason(report) {
	if (report.blocking.length > 0) return `对账里还有 ${String(report.blocking.length)} 条未处置的未登记资产：${report.blocking.join("、")}`;
	if (report.ignored_without_note.length > 0) return `这 ${String(report.ignored_without_note.length)} 条判为 ignored 但没写 note：` + report.ignored_without_note.join("、");
	return "ok";
}
/** The one sentence describing what a call leaves the caller to do. */
function nextStep(report) {
	if (report.ready) return report.dangling.length === 0 ? "证据 ready=true：可以发起付费生图。" : `证据 ready=true：可以发起付费生图；但清单里还有 ${String(report.dangling.length)} 条悬空记录需要修。`;
	return "证据 ready=false：付费生图会被宿主钩子拒绝，先按 ready_reason 把未登记的资产逐条处置。";
}
/**
* Spell one evidence row for the model.
*
* The evidence file carries an absent provider field as JSON null, while the tool
* schema declares plain scalars: the parameter DSL has no nullable scalar, and a
* model reading `0` or an empty string has the same fact — the provider did not
* send this field. `asset_type` 0 therefore means "no category number", never a
* category, because the provider numbers its categories 1, 2 and 3.
* @param item - One evidence row.
* @returns The same row with absent values spelled as an empty string or 0.
*/
function presentUnregistered(item) {
	return {
		asset_id: item.asset_id,
		material_id: item.material_id,
		name: item.name ?? "",
		asset_type: item.asset_type ?? 0,
		is_used: item.is_used,
		hs_asset_status: item.hs_asset_status,
		url: item.url ?? "",
		create_time: item.create_time ?? ""
	};
}
/**
* Spell one dangling record for the model.
* @param item - One evidence record.
* @returns The same record with a missing stable id or name spelled as an empty string.
*/
function presentDangling(item) {
	return {
		stable_id: item.stable_id ?? "",
		jubian_asset_id: item.jubian_asset_id,
		name: item.name ?? "",
		why: item.why
	};
}
/** Assemble one `reconcile` call's result from the evidence it wrote. */
function presentReconcile(report, projectDir) {
	return {
		method: "reconcile",
		ready: report.ready,
		ready_reason: readyReason(report),
		evidence: evidencePath(projectDir),
		script_id: report.script_id,
		ran_at: report.ran_at,
		source: report.source,
		manifest: report.manifest,
		matched: report.matched,
		unregistered: report.unregistered.map(presentUnregistered),
		dangling: report.dangling.map(presentDangling),
		disposition: report.disposition,
		blocking: report.blocking,
		ignored_without_note: report.ignored_without_note,
		policy: report.policy,
		cross_project_note: report.cross_project_note,
		next: nextStep(report)
	};
}
/**
* Assemble one `dispose` call's result from the evidence as written.
*
* The comparison fields are absent rather than defaulted: this call never read the
* remote project, and a count filled with zeros would read as a comparison that
* found nothing. `reconcile` is what produces those fields.
* @param projectDir - Resolved project directory holding the evidence.
* @param assetId - The asset this call disposed of.
* @param evidence - The evidence document {@link disposeAsset} wrote.
* @returns The dispositions, the recomputed verdicts, and the path written to.
*/
function presentDispose(projectDir, assetId, evidence) {
	const { disposition, blocking, ignored_without_note: ignoredWithoutNote } = evidence;
	return {
		method: "dispose",
		asset_id: assetId,
		ready: evidence.ready,
		ready_reason: readyReason({
			blocking,
			ignored_without_note: ignoredWithoutNote
		}),
		evidence: evidencePath(projectDir),
		disposition,
		blocking,
		ignored_without_note: ignoredWithoutNote,
		next: "处置已写入证据：宿主付费钩子下次读到它就会按新的 blocking / ignored_without_note 判定；要刷新远端比对结果与 ran_at，再跑一次 reconcile。"
	};
}
/**
* Run one `drama_assets` call.
* @param client - Jubian transport, used only by `reconcile`.
* @param args - The dispatched arguments.
* @returns The evidence this call wrote, summarized for the model.
* @throws {JubianError} `INVALID_ARGUMENT` for a missing argument,
*   `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this call cannot read.
*/
async function runDramaAssets(client, args) {
	const projectDir = resolveProjectDir(args.project_dir);
	if (args.method === "dispose") {
		const { asset_id: assetId, status, note } = args;
		if (assetId === void 0 || status === void 0) throw new JubianError("INVALID_ARGUMENT", "drama_assets dispose 需要 asset_id 与 status");
		return presentDispose(projectDir, assetId, await disposeAsset(projectDir, assetId, status, note ?? ""));
	}
	return presentReconcile(await reconcileProject(client, projectDir), projectDir);
}
/**
* Model-facing result schema.
*
* One flat object holds both methods' fields, and the two method-specific halves
* are the ones this schema does not require: the parameter DSL rejects
* `required` inside a `oneOf` branch, so a branch-per-method schema would compile
* into branches that match nothing. Every field a call does report is required;
* the fields a method does not report are simply absent from its value, which is
* what the field descriptions say.
*/
const RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		method: {
			type: "string",
			required: true,
			enum: ["reconcile", "dispose"],
			description: "产生本结果的操作；两个方法的字段不同，本 schema 只强制共有字段。"
		},
		ready: {
			type: "boolean",
			required: true,
			description: "证据是否已经可以让宿主钩子放行付费生图：blocking 与 ignored_without_note 都为空才为 true。"
		},
		ready_reason: {
			type: "string",
			required: true,
			description: "ready 的判定依据；放行时为 ok。"
		},
		evidence: {
			type: "string",
			required: true,
			description: "本次写入的证据文件绝对路径（<project_dir>/_probe/asset-reconcile.json）；宿主钩子读的就是它。"
		},
		disposition: {
			type: "object",
			required: true,
			additionalProperties: true,
			description: "每条未登记资产的处置记录，跨次运行保留；值是 {status, note}，status 为 pending / registered / ignored。"
		},
		blocking: {
			type: "array",
			required: true,
			items: { type: "integer" },
			description: "还没处置（不是 registered / ignored）的未登记资产 ID；非空即拒绝付费生图。"
		},
		ignored_without_note: {
			type: "array",
			required: true,
			items: { type: "integer" },
			description: "判为 ignored 但 note 为空的资产 ID；非空即拒绝付费生图。"
		},
		next: {
			type: "string",
			required: true,
			description: "这次之后该做什么，一句中文。"
		},
		asset_id: {
			type: "integer",
			description: "dispose 报告：本次写入处置的资产 ID；reconcile 不带这个字段。"
		},
		script_id: {
			type: "integer",
			description: "reconcile 报告：本次读的剧变项目 ID，取自清单的 script_id；dispose 不重新对账，不带这个字段。"
		},
		ran_at: {
			type: "string",
			description: "reconcile 报告：对账时间（+08:00 的 ISO 时间），证据 24 小时内有效；dispose 沿用证据里的时间但不带这个字段。"
		},
		source: {
			type: "object",
			additionalProperties: false,
			description: "reconcile 报告：远端两侧各读回多少行、比对时算作存活/已选用的有多少。",
			properties: {
				asset_list_rows: {
					type: "integer",
					required: true,
					description: "asset/list 读回的行数（含已删除）。"
				},
				material_list_rows: {
					type: "integer",
					required: true,
					description: "material/list 读回的行数。"
				},
				remote_alive: {
					type: "integer",
					required: true,
					description: "delFlag == \"0\" 的资产数。"
				},
				remote_used: {
					type: "integer",
					required: true,
					description: "isUsed == 1、hsAssetStatus == \"Active\" 且资产仍在的资产数。"
				}
			}
		},
		manifest: {
			type: "object",
			additionalProperties: false,
			description: "reconcile 报告：清单这一侧读到了什么。",
			properties: {
				items: {
					type: "integer",
					required: true,
					description: "assets_manifest.json 的 items 记录数。"
				},
				lead_readonly_records: {
					type: "integer",
					required: true,
					description: "lead_readonly_records 记录数。"
				},
				asset_ids: {
					type: "integer",
					required: true,
					description: "两侧合起来去重后的 jubian_asset_id 数。"
				}
			}
		},
		matched: {
			type: "integer",
			description: "reconcile 报告：远端已选用且清单里也有的资产数。"
		},
		unregistered: {
			type: "array",
			description: `reconcile 报告。这类资产剧变远端已经选用，清单里没有；付费生图前必须逐条处置：要复用就登记进 assets_manifest.json 再跑一次 reconcile 自动标 registered，确认不需要就用 dispose 写 ignored 并说明原因。`,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					asset_id: {
						type: "integer",
						required: true,
						description: "剧变父资产 ID。"
					},
					material_id: {
						type: "integer",
						required: true,
						description: "该资产已选用行的材质 ID。"
					},
					name: {
						type: "string",
						required: true,
						description: "材质行的名字，没有就用资产行的；两行都没有时为空串。"
					},
					asset_type: {
						type: "integer",
						required: true,
						description: "类别号：1=角色，2=场景，3=道具；两行都没有时为 0。"
					},
					is_used: {
						type: "integer",
						required: true,
						description: "材质行的 isUsed，本列表上恒为 1。"
					},
					hs_asset_status: {
						type: "string",
						required: true,
						description: "材质行的 hsAssetStatus，本列表上恒为 Active。"
					},
					url: {
						type: "string",
						required: true,
						description: "材质行或资产行的 URL；都没有时为空串。"
					},
					create_time: {
						type: "string",
						required: true,
						description: "材质行或资产行的创建时间；都没有时为空串。"
					}
				}
			}
		},
		dangling: {
			type: "array",
			description: "reconcile 报告：清单里有、远端 asset/list 里没有的记录，需要修。",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					stable_id: {
						type: "string",
						required: true,
						description: "清单的 stable_id；没有时为空串。"
					},
					jubian_asset_id: {
						type: "integer",
						required: true,
						description: "清单声明的剧变资产 ID。"
					},
					name: {
						type: "string",
						required: true,
						description: "清单里的名字；没有时为空串。"
					},
					why: {
						type: "string",
						required: true,
						description: "为什么这条算悬空。"
					}
				}
			}
		},
		policy: {
			type: "object",
			additionalProperties: false,
			description: "reconcile 报告：付费策略，钩子与本文件读到同一组数字。",
			properties: {
				image_channel: {
					type: "string",
					required: true,
					description: "付费生图走的渠道。"
				},
				image_unit_price_cny: {
					type: "number",
					required: true,
					description: "单张价格，元。"
				},
				max_attempts_per_asset: {
					type: "integer",
					required: true,
					description: "单张最多重试次数。"
				},
				worst_case_cny_per_asset: {
					type: "number",
					required: true,
					description: "单张最坏花费，元。"
				},
				cross_project_reuse: {
					type: "string",
					required: true,
					description: "跨项目复用的做法。"
				}
			}
		},
		cross_project_note: {
			type: "string",
			description: "reconcile 报告：跨项目检索结论（人工填写），沿用证据里的值。"
		}
	}
};
/** What the model reads before calling: what each method does, the verdict rule, and what this tool never does. */
const DESCRIPTION = "短剧流水线的付费生成前资产对账（剧变）。reconcile=只读剧变、免费：把「剧变远端这个项目里已选用的资产」与「assets_manifest.json 里写了什么」逐条比一遍，产出机读证据 <project_dir>/_probe/asset-reconcile.json。判定口径：远端存活 = asset/list 里 delFlag == \"0\"；已选用 = material/list 里 isUsed == 1 且 hsAssetStatus == \"Active\"；unregistered = 已选用但清单里没有（不许直接生成，先登记复用或写明不需要）；dangling = 清单里有但远端没有；matched = 两端都有的数量。dispose=给某条 unregistered 写处置：status=registered（已登记进清单）或 ignored（确认不需要，必须带非空 note）；只更新证据里的 disposition 并重算 blocking / ignored_without_note / ready，不重新对账、不联网。ready = blocking 与 ignored_without_note 都为空，宿主侧的付费前置钩子只认这一条，证据 24 小时内有效。为什么清单不够：清单只记录我们生成过什么，不等于剧变项目里已经有什么——2026-09-20 就因为只看清单，给一张项目里早就存在的正式资产重新生成了两次（花掉 1.17 元）。本工具绝不调用剧变的任何写方法、绝不计费：远端只读，本地只写 _probe/asset-reconcile.json 这一个文件。";
/**
* Present one result to the registry.
*
* The result types carry `disposition` as a map of `{status, note}` while the
* schema declares the same map with open values, so the two are the same JSON
* object and not the same TypeScript type. The cast is at this one seam, and both
* the registry and this package's own suite validate the returned value against
* the declared schema.
* @param value - The canonical result this call computed.
* @returns The value the registered executor returns.
*/
function asRegistered(value) {
	return value;
}
/**
* Register the `drama_assets` tool.
* @param ctx - Host context carrying the tool registry and the credential store.
* @param config - Optional origin, timeout and workspace-secret overrides.
*/
function apply(ctx, config = {}) {
	const client = new JubianClient({
		credential: async () => {
			const stored = (await ctx.credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? "";
			if (stored.trim()) return stored;
			return config.workspaceSecrets === false ? "" : await workspacePipelineToken(process.cwd());
		},
		...config.baseUrl === void 0 ? {} : { baseUrl: config.baseUrl },
		...config.timeoutMs === void 0 ? {} : { timeoutMs: config.timeoutMs }
	});
	ctx.tools.register(defineTool({
		name: "drama_assets",
		description: DESCRIPTION,
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: ["reconcile", "dispose"],
				description: "reconcile=只读剧变做对账并写证据（免费）；dispose=只改证据里的处置记录（不联网）。"
			},
			project_dir: {
				type: "string",
				required: true,
				description: "项目根目录绝对路径，必须含 assets_manifest.json；证据写在它的 _probe/asset-reconcile.json。"
			},
			asset_id: {
				type: "integer",
				description: "dispose 必填：要处置的 unregistered 资产 ID（不是 material_id、不是任务 ID）。"
			},
			status: {
				type: "string",
				enum: ["registered", "ignored"],
				description: "dispose 必填：registered=已登记进清单（下次 reconcile 会自动确认）；ignored=确认不需要，必须同时给 note 说明原因。"
			},
			note: {
				type: "string",
				description: "dispose 可选但 status=ignored 时必填且非空：写清为什么这个资产不需要（例如是别的剧的备选、失败遗留、废弃版本）。"
			}
		},
		output: {
			schema: RESULT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => asRegistered(await runDramaAssets(client, args))
	}));
}
//#endregion
export { apply, inject, name, runDramaAssets, workspacePipelineToken };
