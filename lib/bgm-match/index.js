import { EmotionWorker } from "./worker.js";
import { defaultIndexPath, defaultWeightsPath, resolveCatalogConfig, resolvePython, resolveWeights } from "./config.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createReadStream } from "node:fs";
//#region lib/types/catalog.js
/** Credential-free public catalogue reads and verified, explicit audio downloads. */
const AUDIO_EXTENSION = /^\.(?:mp3|wav|m4a|flac|aac|ogg|opus)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
function object(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid BGM catalog object");
	return value;
}
function parseCatalog(value, config) {
	const catalog = object(value);
	if (catalog.version !== 1 || !Array.isArray(catalog.tracks)) throw new Error("Invalid BGM catalog version or tracks");
	const ids = /* @__PURE__ */ new Set();
	const origin = new URL(config.catalogUrl).origin;
	return catalog.tracks.map((raw) => {
		const row = object(raw);
		if (typeof row.sha256 !== "string" || !DIGEST.test(row.sha256) || row.id !== row.sha256 || ids.has(row.sha256)) throw new Error("Invalid or duplicate BGM catalog track ID");
		if (typeof row.name !== "string" || !row.name.isWellFormed() || row.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(row.name)) throw new Error("Invalid BGM catalog track name");
		const extension = extname(row.name).toLowerCase();
		if (!AUDIO_EXTENSION.test(extension)) throw new Error("Unsupported BGM catalog audio extension");
		const expectedUrl = `${origin}/bgm/tracks/${row.sha256.slice(7)}${extension}`;
		if (row.url !== expectedUrl) throw new Error("BGM catalog track URL must be its same-origin content-addressed object");
		if (typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > config.maxTrackBytes) throw new Error("BGM catalog track size exceeds byte limit");
		for (const key of ["valence", "arousal"]) if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 1 || row[key] > 9) throw new Error(`Invalid BGM catalog ${key}`);
		if (!Array.isArray(row.moods) || row.moods.length > 128 || !row.moods.every((mood) => typeof mood === "string" && mood.length <= 128 && mood.isWellFormed())) throw new Error("Invalid BGM catalog moods");
		ids.add(row.sha256);
		return {
			id: row.sha256,
			sha256: row.sha256,
			name: row.name,
			bytes: row.bytes,
			url: expectedUrl,
			valence: row.valence,
			arousal: row.arousal,
			moods: row.moods
		};
	});
}
async function request(url, signal, maximum) {
	signal.throwIfAborted();
	const response = await fetch(url, {
		method: "GET",
		credentials: "omit",
		redirect: "error",
		signal
	});
	const length = response.headers.get("content-length");
	if (response.status !== 200 || response.redirected || !response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
		await response.body?.cancel();
		throw new Error("BGM download refused: HTTP status, redirect, body or byte limit");
	}
	return response.body;
}
/**
* Fetch and validate one bounded catalogue; never fetch an audio candidate.
* @param config - Resolved public-library settings.
* @param signal - Operation cancellation and deadline.
* @returns Catalogue measurements with validated content-addressed track URLs.
*/
async function loadCatalog(config, signal) {
	const body = await request(config.catalogUrl, signal, config.maxCatalogBytes);
	const chunks = [];
	let bytes = 0;
	for await (const chunk of body) {
		signal.throwIfAborted();
		bytes += chunk.byteLength;
		if (bytes > config.maxCatalogBytes) throw new Error("BGM catalog exceeds byte limit");
		chunks.push(chunk);
	}
	signal.throwIfAborted();
	return parseCatalog(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), config);
}
async function validCache(path, track, signal) {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	if (!info.isFile()) throw new Error("BGM cache entry is not a regular file");
	if (info.size !== track.bytes) return false;
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(path)) {
		signal.throwIfAborted();
		bytes += chunk.length;
		if (bytes > track.bytes) return false;
		hash.update(chunk);
	}
	signal.throwIfAborted();
	return bytes === track.bytes && `sha256:${hash.digest("hex")}` === track.sha256;
}
/**
* Download exactly one catalogue ID and atomically publish verified local bytes.
* @param config - Resolved public-library settings.
* @param trackId - ID selected from this catalogue, not a URL or local filename.
* @param signal - Operation cancellation and deadline, including catalogue fetch.
* @returns A real local path usable by the composer; reuse also verifies SHA-256.
*/
async function downloadTrack(config, trackId, signal) {
	const track = (await loadCatalog(config, signal)).find((candidate) => candidate.id === trackId);
	if (!track) throw new Error("BGM track_id is not in the configured catalog");
	const path = join(config.cacheDir, `${track.sha256.slice(7)}${extname(track.name).toLowerCase()}`);
	const result = {
		track_id: track.id,
		path,
		bytes: track.bytes,
		sha256: track.sha256
	};
	if (await validCache(path, track, signal)) return {
		...result,
		cached: true
	};
	try {
		await unlink(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await mkdir(config.cacheDir, {
		recursive: true,
		mode: 448
	});
	const temporary = await mkdtemp(join(config.cacheDir, ".download-"));
	try {
		const staged = join(temporary, "audio");
		const handle = await open(staged, "wx", 384);
		const hash = createHash("sha256");
		let bytes = 0;
		try {
			const body = await request(track.url, signal, track.bytes);
			for await (const chunk of body) {
				signal.throwIfAborted();
				bytes += chunk.byteLength;
				if (bytes > track.bytes) throw new Error("BGM audio exceeds declared byte size");
				hash.update(chunk);
				await handle.writeFile(chunk);
			}
		} finally {
			await handle.close();
		}
		signal.throwIfAborted();
		if (bytes !== track.bytes || `sha256:${hash.digest("hex")}` !== track.sha256) throw new Error("BGM audio byte size or SHA-256 mismatch");
		try {
			await rename(staged, path);
			return {
				...result,
				cached: false
			};
		} catch (error) {
			if (await validCache(path, track, signal)) return {
				...result,
				cached: true
			};
			throw error;
		}
	} finally {
		await rm(temporary, {
			recursive: true,
			force: true
		});
	}
}
//#endregion
//#region lib/types/index.js
/**
* BGM matching: rank a local library by emotional distance to a target, and report
* what each track actually measures.
*
* Two facts live in the tool description rather than in the code, because a model
* reads the description and not the source: the backbone behind these numbers is
* **non-commercial**, and the output is a ranked list of candidates rather than a
* decision. The second matters — an agent that reads "matched" stops thinking,
* while an agent that reads measured valence/arousal still has to choose.
*
* Ranking is by valence/arousal distance. A 57-track × 15-query evaluation scored
* that 15/15 while the best text-embedding variant scored 14/15, and every text
* variant's similarities sat in a 0.33–0.62 band — too narrow to order on.
*/
const name = "perception-bgm";
const inject = ["tools"];
const SCRIPT = fileURLToPath(new URL("../python/worker_main.py", import.meta.url));
const DATA_DIR = fileURLToPath(new URL("../python/data", import.meta.url));
const AUDIO_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".m4a",
	".flac",
	".aac",
	".ogg",
	".opus"
]);
/** Recursively list audio files, sorted so an interrupted index resumes predictably. */
async function listAudio(directory) {
	const found = [];
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...await listAudio(full));
		else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(full);
	}
	return found.sort();
}
async function loadIndex(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
async function saveIndex(path, tracks) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(tracks, null, 2)}\n`, "utf8");
}
async function hashFile(path) {
	return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}
/** Rank by distance to a target point; the scale is the model's own 1–9. */
function rank(tracks, target, limit) {
	return tracks.map((track) => ({
		track,
		distance: Math.abs(track.valence - target.valence) + Math.abs(track.arousal - target.arousal)
	})).sort((left, right) => left.distance - right.distance).slice(0, limit).map(({ track, distance }) => ({
		..."id" in track ? {
			track_id: track.id,
			name: track.name,
			url: track.url
		} : { path: track.path },
		valence: Number(track.valence.toFixed(2)),
		arousal: Number(track.arousal.toFixed(2)),
		moods: [...track.moods],
		distance: Number(distance.toFixed(2))
	}));
}
function apply(ctx, config = {}) {
	const python = resolvePython(config.pythonExecutable);
	const weights = resolveWeights(config.weightsPath);
	const dataDir = config.dataDir ?? DATA_DIR;
	const indexPath = config.indexPath ?? defaultIndexPath();
	const catalog = resolveCatalogConfig(config);
	const lifetime = new AbortController();
	let worker;
	/** One process, started at most once, with a dependency handshake before use. */
	const ensureWorker = async () => {
		if (python === "") throw new Error("perception-bgm: no usable Python interpreter is configured (set pythonExecutable, or the DSH_PERCEPTION_PYTHON environment variable)");
		const existing = worker;
		if (existing !== void 0 && existing.alive) return existing;
		const created = existing ?? new EmotionWorker({
			pythonExecutable: python,
			scriptPath: SCRIPT,
			env: {
				HF_HUB_DISABLE_TELEMETRY: "1",
				...config.env
			},
			...config.callTimeoutMs === void 0 ? {} : { callTimeoutMs: config.callTimeoutMs }
		});
		worker = created;
		const ready = await created.start();
		if (!ready.ready) throw new Error(`perception-bgm: the worker cannot import its dependencies: ${ready.missing.join("; ")}`);
		return created;
	};
	ctx.effect(() => () => {
		lifetime.abort();
		worker?.dispose();
	}, "perception-bgm: worker and downloads");
	const analyseOne = async (file) => {
		return await (await ensureWorker()).call("analyse", {
			audio_path: file,
			weights_path: weights,
			data_dir: dataDir
		});
	};
	ctx.tools.register(defineTool({
		name: "bgm_match",
		description: "在本地索引或部署配置的公开 BGM 库里按情绪选曲。match：给出目标「愉悦度」与「能量」（都用 1–9 的刻度，1=最消极/最平静，9=最积极/最激烈），返回最接近的候选及每首的实际测量值。index：扫描一个目录，逐首分析情绪并入库；约 15–30 秒一首，按内容哈希增量更新，可随时中断续跑。inspect：只分析一首并返回它的数值。公开库 match 仅返回 track_id/name/url 和测量值，不自动下载；选定后用 download + track_id 下载并校验，返回可供配乐合成使用的真实本地 path。match/download 不需要 Python。**返回的是候选排序，不是决定**——最终选哪首由你判断；每首附带的 valence/arousal 原值就是判断依据。**注意：底层音乐理解骨干 m-a-p/MERT-v1-95M 采用 CC-BY-NC-4.0 许可，仅限非商业用途。**",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"match",
					"index",
					"inspect",
					"download"
				],
				description: "match=按坐标排序候选；index=扫描目录建库（可续跑）；inspect=分析单个音频文件；download=下载公开库中明确选定的 track_id。"
			},
			track_id: {
				type: "string",
				description: "download 必填：公开库 match 返回的 track_id；不接受任意 URL。"
			},
			directory: {
				type: "string",
				description: "index 必填：要扫描的音乐目录。"
			},
			audio_path: {
				type: "string",
				description: "inspect 必填：单个音频文件的路径。"
			},
			valence: {
				type: "number",
				description: "match 必填：目标愉悦度，1–9。"
			},
			arousal: {
				type: "number",
				description: "match 必填：目标能量，1–9。"
			},
			limit: {
				type: "number",
				description: "match 可选：返回候选数，默认 5，上限 20。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		timeoutMs: 1800 * 1e3,
		async execute(args, exec) {
			const networkSignal = (timeoutMs) => AbortSignal.any([
				exec.signal,
				lifetime.signal,
				AbortSignal.timeout(timeoutMs)
			]);
			switch (args.method) {
				case "download":
					if (!catalog) throw new Error("download requires a configured catalogUrl");
					if (typeof args.track_id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(args.track_id)) throw new Error("download requires a catalog track_id (sha256:64 lowercase hex)");
					return await downloadTrack(catalog, args.track_id, networkSignal(catalog.networkTimeoutMs));
				case "match": {
					if (typeof args.valence !== "number" || typeof args.arousal !== "number" || !Number.isFinite(args.valence) || !Number.isFinite(args.arousal) || args.valence < 1 || args.valence > 9 || args.arousal < 1 || args.arousal > 9) throw new Error("match requires numeric valence and arousal on the 1–9 scale");
					const tracks = catalog ? await loadCatalog(catalog, networkSignal(catalog.networkTimeoutMs)) : await loadIndex(indexPath);
					if (tracks.length === 0) throw new Error(catalog ? "no tracks in the configured BGM catalog" : `no indexed tracks at ${indexPath}; run index on a music directory first`);
					const limit = Math.min(Math.max(Math.trunc(args.limit ?? 5), 1), 20);
					return {
						target: {
							valence: args.valence,
							arousal: args.arousal
						},
						evaluated_tracks: tracks.length,
						candidates: rank(tracks, {
							valence: args.valence,
							arousal: args.arousal
						}, limit),
						note: "candidates are ranked by measured distance; choose one yourself."
					};
				}
				case "index": {
					if (args.directory === void 0 || args.directory.trim() === "") throw new Error("index requires directory");
					const files = await listAudio(resolve(args.directory));
					const tracks = await loadIndex(indexPath);
					const byPath = new Map(tracks.map((track) => [track.path, track]));
					const failures = [];
					let analysed = 0;
					let unchanged = 0;
					for (const file of files) {
						const info = await stat(file);
						const known = byPath.get(file);
						if (known !== void 0 && known.bytes === info.size && known.modified_ms === info.mtimeMs) {
							unchanged += 1;
							continue;
						}
						const sha256 = await hashFile(file);
						if (known !== void 0 && known.sha256 === sha256) {
							byPath.set(file, {
								...known,
								bytes: info.size,
								modified_ms: info.mtimeMs
							});
							unchanged += 1;
							continue;
						}
						try {
							const analysis = await analyseOne(file);
							byPath.set(file, {
								path: file,
								sha256,
								bytes: info.size,
								modified_ms: info.mtimeMs,
								valence: analysis.valence,
								arousal: analysis.arousal,
								moods: analysis.moods
							});
							analysed += 1;
						} catch (error) {
							failures.push({
								path: file,
								error: error instanceof Error ? error.message : String(error)
							});
						}
						await saveIndex(indexPath, [...byPath.values()]);
					}
					const finalTracks = [...byPath.values()];
					await saveIndex(indexPath, finalTracks);
					return {
						scanned: files.length,
						indexed: finalTracks.length,
						analysed,
						unchanged,
						failures,
						index_path: indexPath
					};
				}
				case "inspect": {
					if (args.audio_path === void 0 || args.audio_path.trim() === "") throw new Error("inspect requires audio_path");
					const file = resolve(args.audio_path);
					const analysis = await analyseOne(file);
					return {
						path: file,
						valence: Number(analysis.valence.toFixed(4)),
						arousal: Number(analysis.arousal.toFixed(4)),
						moods: analysis.moods,
						dropped_trailing_samples: analysis.dropped_trailing_samples ?? 0
					};
				}
			}
		}
	}));
}
//#endregion
export { apply, defaultWeightsPath, inject, name };
