import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
//#region lib/types/media.js
/** FFmpeg process helpers and no-clobber publication for BGM artifacts. */
const UNKNOWN_EXIT_CODE = 127;
/** A failed FFmpeg or ffprobe command with its diagnostic tail. */
var MediaCommandError = class extends Error {
	/** Executable that failed. */
	command;
	/** Arguments supplied to the executable. */
	args;
	/** Process exit code. */
	code;
	/** Captured standard error. */
	stderr;
	/**
	* Record one command failure.
	* @param command - Executable that failed.
	* @param args - Arguments supplied to the executable.
	* @param outcome - Captured process outcome.
	*/
	constructor(command, args, outcome) {
		super(`${command} ${args.join(" ")} 退出码 ${String(outcome.code)}：${outcome.stderr.slice(-4e3)}`);
		this.name = "MediaCommandError";
		this.command = command;
		this.args = [...args];
		this.code = outcome.code;
		this.stderr = outcome.stderr;
	}
};
/**
* Adapt the Harness subprocess service to the composer's process channel.
* @param subprocess - Provider-managed subprocess service.
* @param cwd - Project directory used by every media command.
* @param timeoutMs - Maximum duration of one command.
* @param graceMs - Provider termination grace.
* @param outputMaxBytes - In-memory cap for each collected stream.
* @returns A channel that resolves executables in the provider's execution world.
*/
function createSubprocessChannel(subprocess, cwd, timeoutMs, graceMs, outputMaxBytes) {
	return { run: async (command, args, signal) => {
		const timeout = AbortSignal.timeout(timeoutMs);
		const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
		const executable = await subprocess.resolveExecutable(command, void 0, combined);
		const handle = subprocess.spawn({
			argv: [executable, ...args],
			cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: outputMaxBytes },
				stderr: { maxBytes: outputMaxBytes }
			},
			graceMs,
			signal: combined
		});
		const outcome = await handle.done;
		combined.throwIfAborted();
		const stdout = handle.collected.stdout?.readFrom(0);
		const stderr = handle.collected.stderr?.readFrom(0);
		if (stdout === void 0 || stderr === void 0) throw new Error("媒体命令没有返回可收集的输出流。");
		if (stdout.lossy || stderr.lossy) throw new Error("媒体命令输出超过收集上限。");
		return {
			code: outcome.exitCode ?? UNKNOWN_EXIT_CODE,
			stdout: stdout.text,
			stderr: `${stderr.text}${outcome.signal === null ? "" : `\nterminated by ${outcome.signal}`}`
		};
	} };
}
/**
* Build the source-analysis operations used by preview and compose.
* @param ffmpegPath - FFmpeg executable.
* @param _ffprobePath - Reserved ffprobe executable for the complete toolkit.
* @param channel - Process channel.
* @returns Media analysis operations.
*/
function createMediaToolkit(ffmpegPath, _ffprobePath, channel) {
	const checked = async (args, signal) => {
		const outcome = await channel.run(ffmpegPath, args, signal);
		if (outcome.code !== 0) throw new MediaCommandError(ffmpegPath, args, outcome);
		return outcome;
	};
	return {
		detectSourceStart: async (source, signal) => {
			const outcome = await checked([
				"-hide_banner",
				"-nostats",
				"-ss",
				"1",
				"-t",
				"4",
				"-i",
				source,
				"-af",
				"silencedetect=noise=-45dB:d=0.08",
				"-f",
				"null",
				"-"
			], signal);
			const silence = /silence_start:\s*(-?[0-9]+(?:\.[0-9]+)?)(?:.|\n)*?silence_end:\s*([0-9]+(?:\.[0-9]+)?)/u.exec(outcome.stderr);
			const startsSilent = /silence_start:\s*(-?[0-9]+(?:\.[0-9]+)?)/u.exec(outcome.stderr);
			if (startsSilent === null || Math.abs(Number(startsSilent[1])) > .001) return {
				seconds: 1,
				kind: "onset"
			};
			if (silence === null) throw new Error(`BGM 在 1–5 秒内没有可用起音：${source}`);
			const seconds = 1 + Number(silence[2]);
			if (!Number.isFinite(seconds) || seconds >= 5) throw new Error(`BGM 在 1–5 秒内没有可用起音：${source}`);
			return {
				seconds: Number(seconds.toFixed(6)),
				kind: "onset"
			};
		},
		meanVolume: async (source, startSeconds, durationSeconds, signal) => {
			const outcome = await checked([
				"-hide_banner",
				"-nostats",
				"-ss",
				startSeconds.toFixed(6),
				"-t",
				durationSeconds.toFixed(6),
				"-i",
				source,
				"-af",
				"volumedetect",
				"-f",
				"null",
				"-"
			], signal);
			const match = /mean_volume:\s*(-?(?:[0-9]+(?:\.[0-9]+)?|inf))\s*dB/iu.exec(outcome.stderr);
			if (match === null || match[1]?.toLowerCase() === "-inf") throw new Error(`无法测量 BGM 源曲响度：${source}`);
			return Number(match[1]);
		}
	};
}
/**
* Probe one audio file through ffprobe.
* @param ffprobePath - ffprobe executable.
* @param channel - Process channel.
* @param path - Audio file path.
* @param signal - Optional cancellation signal.
* @returns Parsed audio facts.
*/
async function probeAudio(ffprobePath, channel, path, signal) {
	const args = [
		"-v",
		"error",
		"-show_streams",
		"-show_format",
		"-of",
		"json",
		path
	];
	const outcome = await channel.run(ffprobePath, args, signal);
	if (outcome.code !== 0) throw new MediaCommandError(ffprobePath, args, outcome);
	let document;
	try {
		document = JSON.parse(outcome.stdout);
	} catch (error) {
		throw new Error(`ffprobe 返回了无效 JSON：${path}`, { cause: error });
	}
	if (typeof document !== "object" || document === null) throw new Error(`ffprobe 缺少媒体信息：${path}`);
	const root = document;
	if (!Array.isArray(root.streams) || typeof root.format !== "object" || root.format === null) throw new Error(`ffprobe 缺少媒体信息：${path}`);
	const stream = root.streams.find((item) => typeof item === "object" && item !== null && item.codec_type === "audio");
	if (stream === void 0) throw new Error(`媒体没有音频流：${path}`);
	const format = root.format;
	const formatName = typeof format.format_name === "string" ? format.format_name : "";
	const codec = typeof stream.codec_name === "string" ? stream.codec_name : "";
	const sampleRate = Number(stream.sample_rate);
	const channels = Number(stream.channels);
	const durationSeconds = Number(format.duration);
	const sizeBytes = Number(format.size);
	if (!formatName || !codec || !Number.isFinite(sampleRate) || !Number.isFinite(channels) || !Number.isFinite(durationSeconds) || !Number.isFinite(sizeBytes)) throw new Error(`ffprobe 音频信息不完整：${path}`);
	return {
		formatName,
		codec,
		sampleRate,
		channels,
		durationSeconds,
		sizeBytes
	};
}
/**
* Run the final FFmpeg mix command.
* @param ffmpegPath - FFmpeg executable.
* @param channel - Process channel.
* @param sources - Ordered source audio paths.
* @param filter - Complete filter-complex graph.
* @param output - Staged WAV path.
* @param signal - Optional cancellation signal.
*/
async function renderBgm(ffmpegPath, channel, sources, filter, output, signal) {
	const args = [
		"-y",
		"-v",
		"error",
		...sources.flatMap((source) => ["-i", source]),
		"-filter_complex",
		filter,
		"-map",
		"[bgmout]",
		"-c:a",
		"pcm_s16le",
		"-ar",
		"48000",
		"-ac",
		"2",
		output
	];
	const outcome = await channel.run(ffmpegPath, args, signal);
	if (outcome.code !== 0) throw new MediaCommandError(ffmpegPath, args, outcome);
}
/**
* Publish staged files without overwriting an existing destination.
*
* Every staged file must share a volume with its destination. A conflict or
* link failure removes only destinations created by this call and retains every
* staged file so the caller can clean it in one place.
* @param pairs - Staged and final path pairs.
*/
async function publishNoClobber(pairs) {
	const created = [];
	try {
		for (const [temporary, final] of pairs) {
			await link(temporary, final);
			created.push(final);
		}
	} catch (error) {
		await Promise.all(created.reverse().map(async (path) => {
			try {
				await unlink(path);
			} catch (unlinkError) {
				if (unlinkError.code !== "ENOENT") throw unlinkError;
			}
		}));
		throw error;
	}
	await Promise.all(pairs.map(async ([temporary]) => {
		await unlink(temporary);
	}));
}
/** Shared source-window mean used by the short-drama renderer. */
const TARGET_MEAN_DB = -17.5;
const EPSILON_SECONDS = .001;
/** The policy the short-drama pipeline runs with. */
const DEFAULT_BGM_BATCH_POLICY = {
	minTracksPerEpisode: 2,
	maxEpisodesPerTrack: 2,
	freshTracksPerEpisode: 1,
	boundaryToleranceSeconds: .05
};
/**
* Resolve the identity one segment's track has across a batch.
*
* Two episodes share a track when their sources resolve to the same file. The
* plan's own `track` label is a display name and is not compared: production
* plans have carried two labels for one file and one label for two files.
* @param project - Project root that relative sources resolve against.
* @param source - The segment's declared source.
* @returns The absolute path that identifies the track.
*/
function trackIdentity(project, source) {
	return isAbsolute(source) ? resolve(source) : resolve(project, source);
}
/**
* Audit one episode's plan against the batch rules.
*
* The rules are per batch, so a single episode cannot be judged alone: a track
* two episodes share only becomes a problem when a third one joins, and a fresh
* track is fresh only relative to what the other episodes used.
*
* Nothing here blocks the call. The findings are returned in the tool result so
* the agent reads them before delivering, and each one says what to change.
* @param selected - The episode being composed.
* @param context - The batch, its boundaries, and the limits.
* @returns One finding per rule the plan breaks, in rule order; empty when it breaks none.
*/
function auditBgmBatch(selected, context) {
	const limits = context.limits ?? DEFAULT_BGM_BATCH_POLICY;
	const episode = selected.episode;
	const findings = [];
	const tracks = selected.segments.map((segment) => trackIdentity(context.project, segment.source));
	const distinct = [...new Set(tracks)];
	if (distinct.length < limits.minTracksPerEpisode) findings.push({
		rule: "R1",
		detail: `第 ${episode} 集只用了 ${String(distinct.length)} 首曲子，用户要求每集至少 ${String(limits.minTracksPerEpisode)} 首。`,
		fix: "按正文情绪把这一集再分成至少 2 段，各用一首不同曲子，然后重跑 preview。"
	});
	if (distinct.length !== tracks.length) {
		const repeated = tracks.filter((track, index) => tracks.indexOf(track) !== index);
		findings.push({
			rule: "R2",
			detail: `第 ${episode} 集在 ${String(tracks.length)} 段里重复使用了同一首曲子：${[...new Set(repeated)].join("、")}。`,
			fix: "把重复段落中的后几段换成别的曲子；同一集内每段一首不同的曲子。"
		});
	}
	const users = /* @__PURE__ */ new Map();
	const members = /* @__PURE__ */ new Map();
	for (const row of [...context.batch, selected]) members.set(row.episode.padStart(2, "0"), row);
	for (const row of members.values()) for (const segment of row.segments) {
		const id = trackIdentity(context.project, segment.source);
		const list = users.get(id) ?? /* @__PURE__ */ new Set();
		list.add(row.episode.padStart(2, "0"));
		users.set(id, list);
	}
	for (const id of distinct) {
		const episodes = [...users.get(id) ?? /* @__PURE__ */ new Set()].sort();
		if (episodes.length > limits.maxEpisodesPerTrack) findings.push({
			rule: "R3",
			detail: `曲目 ${id} 出现在 ${String(episodes.length)} 集（${episodes.join("、")}），超过整批上限 ${String(limits.maxEpisodesPerTrack)} 集。`,
			fix: `从 ${episodes.slice(limits.maxEpisodesPerTrack).join("、")} 里换掉这首，另选一首情绪接近、本批还没用满的曲子。`
		});
	}
	if (distinct.filter((id) => (users.get(id) ?? /* @__PURE__ */ new Set()).size === 1).length < limits.freshTracksPerEpisode) findings.push({
		rule: "R4",
		detail: `第 ${episode} 集没有任何一首是本批其它集没用的，用户要求每集至少 ${String(limits.freshTracksPerEpisode)} 首全新曲目。`,
		fix: "为本集换入一首本批其它集都没用过的曲子（可用 bgm_match 按这一段正文的情绪取候选）。"
	});
	if (context.boundaries.length === 0) {
		findings.push({
			rule: "R5",
			detail: `第 ${episode} 集的切点无法核对：时间线里没有镜头包边界（clips）。`,
			fix: "确认传的是本集时间线（含 clips，通常是 prepare 写出的 editing/<集>-timeline.json），再重跑。"
		});
		return findings.sort((left, right) => left.rule.localeCompare(right.rule));
	}
	for (const [index, segment] of selected.segments.entries()) {
		if (index === 0) continue;
		const nearest = context.boundaries.map((boundary) => ({
			boundary,
			distance: Math.abs(boundary - segment.start_seconds)
		})).sort((left, right) => left.distance - right.distance)[0];
		if (nearest === void 0 || nearest.distance > limits.boundaryToleranceSeconds) findings.push({
			rule: "R5",
			detail: `第 ${episode} 集的切点 ${segment.start_seconds.toFixed(3)}s 不在任何镜头包边界上${nearest === void 0 ? "" : `（最近的是 ${nearest.boundary.toFixed(3)}s）`}。`,
			fix: "把切点移到某个镜头包的起点；段的时间必须与时间线的包边界对齐。"
		});
	}
	return findings.sort((left, right) => left.rule.localeCompare(right.rule));
}
/**
* Derive the amount of source audio each story interval contributes before overlaps are removed.
* @param segments - Contiguous story intervals.
* @param crossfadeSeconds - Adjacent overlap duration.
* @returns One source duration per segment.
*/
function segmentInputDurations(segments, crossfadeSeconds) {
	const half = crossfadeSeconds / 2;
	return segments.map((segment, index) => Number((segment.end_seconds - segment.start_seconds + (index === 0 ? half : crossfadeSeconds) - (index === segments.length - 1 ? half : 0)).toFixed(6)));
}
/**
* Validate one episode row against the measured body duration.
* @param input - Parsed plan row.
* @param bodyDurationSeconds - Body duration measured from the episode timeline.
* @returns Values safe to pass to the analyzer and FFmpeg graph builder.
*/
function validateEpisodePlan(input, bodyDurationSeconds) {
	if (!Number.isFinite(bodyDurationSeconds) || bodyDurationSeconds <= 0 || !Number.isFinite(input.body_duration_seconds) || Math.abs(input.body_duration_seconds - bodyDurationSeconds) > EPSILON_SECONDS) throw new Error("BGM 计划正文时长与当前时间线不一致。");
	const crossfadeSeconds = input.crossfade_seconds ?? 1.5;
	if (!Number.isFinite(crossfadeSeconds) || crossfadeSeconds <= 0) throw new Error("BGM 交叉淡化时长必须大于零。");
	if (!Array.isArray(input.segments) || input.segments.length === 0) throw new Error("BGM 计划没有段落。");
	let expectedStart = 0;
	for (const segment of input.segments) {
		if (!segment.track.trim() || !segment.source.trim()) throw new Error("BGM 段落必须包含曲目和来源。");
		if (!segment.reason.trim()) throw new Error("BGM 段落必须记录选曲理由。");
		if (!Number.isFinite(segment.start_seconds) || !Number.isFinite(segment.end_seconds) || segment.end_seconds <= segment.start_seconds || Math.abs(segment.start_seconds - expectedStart) > EPSILON_SECONDS) throw new Error("BGM 段落必须按顺序连续覆盖正文。");
		if (segment.source_start_seconds !== void 0 && (!Number.isFinite(segment.source_start_seconds) || segment.source_start_seconds < 0)) throw new Error("BGM 源曲起点必须是非负秒数。");
		expectedStart = segment.end_seconds;
	}
	if (Math.abs(expectedStart - bodyDurationSeconds) > EPSILON_SECONDS) throw new Error("BGM 段落必须按顺序连续覆盖正文。");
	const lengths = segmentInputDurations(input.segments, crossfadeSeconds);
	if (input.segments.some((segment, index) => {
		const inputDuration = lengths[index];
		return inputDuration === void 0 || inputDuration <= crossfadeSeconds || segment.end_seconds - segment.start_seconds < crossfadeSeconds;
	})) throw new Error("BGM 交叉淡化不能长于最短剧情段。");
	return {
		bodyDurationSeconds,
		crossfadeSeconds,
		segments: input.segments.map((segment, index) => {
			const inputDurationSeconds = lengths[index];
			if (inputDurationSeconds === void 0) throw new Error("BGM 段落时长数量不一致。");
			return {
				...segment,
				inputDurationSeconds
			};
		})
	};
}
/**
* Calculate the source-window gain used before crossfading.
* @param meanDb - Mean volume reported by FFmpeg volumedetect.
* @returns Gain in decibels, capped at {@link MAX_BOOST_DB}.
*/
function appliedGain(meanDb) {
	if (!Number.isFinite(meanDb)) throw new Error("BGM 源曲响度不是有效数值。");
	return Number(Math.min(TARGET_MEAN_DB - meanDb, 9).toFixed(1));
}
/**
* Build the complete audio graph for ordered source tracks.
* @param inputDurations - Source contribution durations before overlaps are removed.
* @param sourceStarts - Source offsets in seconds.
* @param gainsDb - Per-source gain in decibels.
* @param bodyDurationSeconds - Exact output duration.
* @param crossfadeSeconds - Adjacent overlap duration.
* @returns An FFmpeg filter-complex graph ending at `[bgmout]`.
*/
function buildMixFilter(inputDurations, sourceStarts, gainsDb, bodyDurationSeconds, crossfadeSeconds) {
	if (inputDurations.length === 0 || sourceStarts.length !== inputDurations.length || gainsDb.length !== inputDurations.length) throw new Error("BGM 混音参数数量不一致。");
	const filters = inputDurations.map((duration, index) => {
		const sourceStart = sourceStarts[index];
		const gainDb = gainsDb[index];
		if (sourceStart === void 0 || gainDb === void 0) throw new Error("BGM 混音参数数量不一致。");
		return `[${index}:a]atrim=start=${sourceStart.toFixed(6)}:duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS,volume=${gainDb.toFixed(1)}dB[s${index}]`;
	});
	let current = "s0";
	for (let index = 1; index < inputDurations.length; index += 1) {
		const next = `x${index}`;
		filters.push(`[${current}][s${index}]acrossfade=d=${crossfadeSeconds.toFixed(6)}:c1=tri:c2=tri[${next}]`);
		current = next;
	}
	const fadeOutStart = Math.max(0, bodyDurationSeconds - 2.5);
	filters.push(`[${current}]atrim=0:${bodyDurationSeconds.toFixed(6)},afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOutStart.toFixed(6)}:d=2.5[bgmout]`);
	return filters.join(";");
}
/**
* Resolve an output path while rejecting every path outside the project root.
* @param project - Project root.
* @param candidate - Absolute or project-relative output path.
* @returns Absolute path inside the project.
*/
function resolveOutputPath(project, candidate) {
	const root = resolve(project);
	const output = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
	const relation = relative(root, output);
	if (relation === ".." || relation.startsWith("..\\") || relation.startsWith("../") || isAbsolute(relation)) throw new Error("BGM 输出必须位于项目目录内。");
	return output;
}
//#endregion
//#region lib/types/compose.js
/** Preview, compose, and verify one episode's planned BGM bed. */
const EMPTY_MEDIA = {
	codec: "",
	sample_rate: 0,
	channels: 0,
	duration_seconds: 0,
	size_bytes: 0,
	sha256: ""
};
const SegmentSchema = z.object({
	track: z.string().required(),
	source: z.string().required(),
	start_seconds: z.number().required(),
	end_seconds: z.number().required(),
	reason: z.string().required(),
	source_start_seconds: z.number(),
	source_sha256: z.string(),
	valence: z.number(),
	arousal: z.number()
});
const EpisodeSchema = z.object({
	episode: z.string().required(),
	body_duration_seconds: z.number().required(),
	crossfade_seconds: z.number(),
	segments: z.array(SegmentSchema).required()
});
const PlanSchema = z.object({ episodes: z.array(EpisodeSchema).required() });
/** Calculate one file's SHA-256 without loading it into one buffer. */
async function sha256File(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
/** Require one path to name an existing regular, non-empty file. */
async function requireFile(path, label, displayPath = path) {
	let info;
	try {
		info = await stat(path);
	} catch (error) {
		if (error.code === "ENOENT") throw new Error(`${label}不存在：${displayPath}`, { cause: error });
		throw error;
	}
	if (!info.isFile() || info.size === 0) throw new Error(`${label}不是非空文件：${displayPath}`);
}
/** Reject a real path outside the project's real root. */
function assertProjectOwned(project, path, label) {
	const relation = relative(project, path);
	if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error(`${label}必须位于项目目录内：${path}`);
}
/** Require an existing project-owned file, including after symlink resolution. */
async function requireProjectFile(project, path, label, displayPath = path) {
	await requireFile(path, label, displayPath);
	assertProjectOwned(project, await realpath(path), label);
}
/** Create an output directory only when its nearest existing ancestor is project-owned. */
async function ensureProjectDirectory(project, path) {
	let ancestor = path;
	while (true) try {
		assertProjectOwned(project, await realpath(ancestor), "BGM 输出目录");
		break;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const parent = dirname(ancestor);
		if (parent === ancestor) throw error;
		ancestor = parent;
	}
	await mkdir(path, { recursive: true });
	assertProjectOwned(project, await realpath(path), "BGM 输出目录");
}
/** Return whether a path already exists without swallowing other filesystem errors. */
async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
/** Read the timeline's measured body end and its package boundaries. */
async function readTimeline(path) {
	let document;
	try {
		document = JSON.parse((await readFile(path, "utf8")).replace(/^\ufeff/u, ""));
	} catch (error) {
		throw new Error(`时间线不可读：${path}`, { cause: error });
	}
	const body = typeof document === "object" && document !== null ? Number(document.body_end) : NaN;
	if (!Number.isFinite(body) || body <= 0) throw new Error(`时间线缺少有效 body_end：${path}`);
	const clips = document.clips;
	const boundaries = (Array.isArray(clips) ? clips : []).map((clip) => Number(clip.start_us) / 1e6).filter((seconds) => Number.isFinite(seconds) && seconds > 0);
	return {
		bodyEndSeconds: body,
		boundaries: [...new Set(boundaries)].sort((left, right) => left - right)
	};
}
/**
* Read every plan in one directory.
*
* A batch is the plan directory's own contents, which is how the pipeline lays
* episodes out (`episodes/segments/<集>.json`). A JSON file that parses but
* carries no `episodes` array is not a plan and is ignored, so a timeline may
* sit beside the plans. A file that cannot be parsed at all is a failure: it
* might be a plan, and a batch quietly missing one member would let a track
* exceed its limit with nothing reporting it.
* @param directory - The directory holding the selected plan.
* @returns Every episode row found, in directory order.
* @throws {Error} When a JSON file in the directory cannot be read as JSON.
*/
async function loadBatch(directory) {
	const rows = [];
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue;
		const path = join(directory, entry.name);
		let document;
		try {
			document = JSON.parse((await readFile(path, "utf8")).replace(/^\ufeff/u, ""));
		} catch (error) {
			throw new Error(`${directory} 里的 ${entry.name} 不是可读的 JSON：同一目录的 JSON 可能属于同一批，读不出来就无法判断跨集复用。请把不相关的文件移出该目录，或修好它后重试。`, { cause: error });
		}
		if (typeof document !== "object" || document === null || !Array.isArray(document.episodes)) continue;
		let parsed;
		try {
			parsed = PlanSchema(document);
		} catch (error) {
			throw new Error(`${directory} 里的 ${entry.name} 有 episodes 数组但不是合法的 BGM 计划：请修好它的字段后重试。`, { cause: error });
		}
		for (const row of parsed.episodes) rows.push({
			episode: row.episode,
			segments: [...row.segments]
		});
	}
	return rows;
}
/** Read and select one episode while reporting repeated ordered source sequences. */
async function loadPlan(path, episode, project) {
	let plan;
	try {
		plan = PlanSchema(JSON.parse((await readFile(path, "utf8")).replace(/^\ufeff/u, "")));
	} catch (error) {
		throw new Error(`BGM 计划不可读：${path}`, { cause: error });
	}
	const ids = plan.episodes.map((row) => row.episode.padStart(2, "0"));
	if (ids.some((id) => !/^\d+$/u.test(id)) || new Set(ids).size !== ids.length) throw new Error("BGM 计划集号重复或无效。");
	const selected = plan.episodes.find((row) => row.episode.padStart(2, "0") === episode);
	if (selected === void 0) throw new Error(`BGM 计划缺少第 ${episode} 集。`);
	const signature = (row) => JSON.stringify(row.segments.map((segment) => isAbsolute(segment.source) ? resolve(segment.source) : resolve(project, segment.source)));
	const selectedSignature = signature(selected);
	const batch = await loadBatch(dirname(path));
	return {
		selected,
		repeated: plan.episodes.filter((row) => row !== selected && signature(row) === selectedSignature).map((row) => row.episode.padStart(2, "0")),
		batch,
		batchEpisodes: [...new Set(batch.map((row) => row.episode.padStart(2, "0")))].sort()
	};
}
/** Convert an ffprobe result and digest into the public media report. */
async function mediaReport(path, probe) {
	return {
		codec: probe.codec,
		sample_rate: probe.sampleRate,
		channels: probe.channels,
		duration_seconds: probe.durationSeconds,
		size_bytes: probe.sizeBytes,
		sha256: await sha256File(path)
	};
}
/** Enforce the composer's fixed WAV format and exact body duration. */
function validateOutput(probe, bodyDurationSeconds) {
	if (!probe.formatName.split(",").includes("wav") || probe.codec !== "pcm_s16le" || probe.sampleRate !== 48e3 || probe.channels !== 2 || Math.abs(probe.durationSeconds - bodyDurationSeconds) > .02) throw new Error("BGM 输出必须是 WAV 容器、pcm_s16le、48kHz、双声道，且时长与正文误差不超过 0.02 秒。");
}
/** Resolve one plan source relative to the project. */
function sourcePath(project, source) {
	return isAbsolute(source) ? resolve(source) : resolve(project, source);
}
/** Analyze every source contribution and preserve its story and matcher evidence. */
async function analyzeSegments(project, plan, settings) {
	const media = createMediaToolkit(settings.ffmpegPath, settings.ffprobePath, settings.channel);
	const reports = [];
	for (const segment of plan.segments) {
		const source = sourcePath(project, segment.source);
		await requireFile(source, "BGM 源曲");
		const digest = await sha256File(source);
		if (segment.source_sha256 !== void 0 && segment.source_sha256.replace(/^sha256:/u, "").toLowerCase() !== digest) throw new Error(`BGM 源曲摘要已变化：${source}`);
		const start = segment.source_start_seconds === void 0 ? await media.detectSourceStart(source, settings.signal) : {
			seconds: segment.source_start_seconds,
			kind: "explicit"
		};
		const sourceProbe = await probeAudio(settings.ffprobePath, settings.channel, source, settings.signal);
		if (start.seconds + segment.inputDurationSeconds > sourceProbe.durationSeconds + .001) throw new Error(`BGM 源曲不足以覆盖剧情段：${source}`);
		const mean = await media.meanVolume(source, start.seconds, segment.inputDurationSeconds, settings.signal);
		reports.push({
			track: segment.track,
			source,
			source_sha256: digest,
			start_seconds: segment.start_seconds,
			end_seconds: segment.end_seconds,
			reason: segment.reason,
			input_duration_seconds: segment.inputDurationSeconds,
			source_start_seconds: start.seconds,
			source_start_kind: start.kind,
			source_mean_db: mean,
			applied_gain_db: appliedGain(mean),
			...segment.valence === void 0 ? {} : { valence: segment.valence },
			...segment.arousal === void 0 ? {} : { arousal: segment.arousal }
		});
	}
	return reports;
}
/**
* Preview, compose, or verify an episode BGM bed.
* @param args - Model-facing operation arguments.
* @param settings - Resolved executables, process channel, and cancellation.
* @returns Canonical analysis and output report.
*/
async function runDramaBgm(args, settings) {
	if (!Number.isSafeInteger(args.episode) || args.episode <= 0) throw new Error("episode 必须是正安全整数。");
	const project = resolve(args.project);
	const projectRoot = await realpath(project);
	const timeline = resolveOutputPath(project, args.timeline);
	const planPath = resolveOutputPath(project, args.plan);
	await requireProjectFile(projectRoot, timeline, "时间线", args.timeline);
	await requireProjectFile(projectRoot, planPath, "BGM 计划", args.plan);
	const episode = String(args.episode).padStart(2, "0");
	const { bodyEndSeconds, boundaries } = await readTimeline(timeline);
	const loaded = await loadPlan(planPath, episode, project);
	const plan = validateEpisodePlan(loaded.selected, bodyEndSeconds);
	const policyFindings = auditBgmBatch({
		episode,
		segments: loaded.selected.segments
	}, {
		project,
		batch: loaded.batch,
		boundaries,
		...settings.policy === void 0 ? {} : { limits: settings.policy }
	});
	const output = resolveOutputPath(project, args.output ?? `audio/bgm/${episode}.wav`);
	if (extname(output).toLowerCase() !== ".wav") throw new Error("BGM 输出必须使用 .wav 扩展名。");
	const parsed = parse(output);
	const reportPath = resolve(parsed.dir, `${parsed.name}.generation.json`);
	const base = {
		episode,
		project,
		plan: planPath,
		timeline,
		output,
		body_duration_seconds: bodyEndSeconds,
		crossfade_seconds: plan.crossfadeSeconds,
		repeated_sequence_episodes: loaded.repeated,
		batch_episodes: loaded.batchEpisodes,
		policy_findings: policyFindings
	};
	if (args.method === "verify") {
		await requireProjectFile(projectRoot, output, "BGM 输出", args.output ?? `audio/bgm/${episode}.wav`);
		const probe = await probeAudio(settings.ffprobePath, settings.channel, output, settings.signal);
		validateOutput(probe, bodyEndSeconds);
		return {
			method: "verify",
			...base,
			segments: [],
			report: "",
			media: await mediaReport(output, probe)
		};
	}
	const segments = await analyzeSegments(project, plan, settings);
	const analyzed = {
		...base,
		segments
	};
	if (args.method === "preview") return {
		method: "preview",
		...analyzed,
		report: "",
		media: EMPTY_MEDIA
	};
	if (await exists(output)) throw new Error(`BGM 输出已存在，不会覆盖：${output}`);
	if (await exists(reportPath)) throw new Error(`BGM 报告已存在，不会覆盖：${reportPath}`);
	await ensureProjectDirectory(projectRoot, dirname(output));
	const wavTemporary = resolve(dirname(output), `.${parsed.name}-${randomUUID()}.wav`);
	const reportTemporary = resolve(dirname(reportPath), `.${parsed.name}-${randomUUID()}.json`);
	try {
		await (await open(wavTemporary, "wx")).close();
		const graph = buildMixFilter(segments.map((segment) => segment.input_duration_seconds), segments.map((segment) => segment.source_start_seconds), segments.map((segment) => segment.applied_gain_db), bodyEndSeconds, plan.crossfadeSeconds);
		await renderBgm(settings.ffmpegPath, settings.channel, segments.map((segment) => segment.source), graph, wavTemporary, settings.signal);
		const probe = await probeAudio(settings.ffprobePath, settings.channel, wavTemporary, settings.signal);
		validateOutput(probe, bodyEndSeconds);
		const report = {
			method: "compose",
			...analyzed,
			report: reportPath,
			media: await mediaReport(wavTemporary, probe)
		};
		const reportHandle = await open(reportTemporary, "wx");
		try {
			await reportHandle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
		} finally {
			await reportHandle.close();
		}
		settings.signal?.throwIfAborted();
		await publishNoClobber([[wavTemporary, output], [reportTemporary, reportPath]]);
		return report;
	} finally {
		await Promise.all([wavTemporary, reportTemporary].map(async (path) => {
			try {
				await unlink(path);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}));
	}
}
//#endregion
//#region lib/types/index.js
/** Cordis plugin exposing deterministic short-drama BGM preview, composition, and verification. */
/** Cordis plugin identity. */
const name = "tool-bgm-compose";
/** Required registries and the provider-managed process service. */
const inject = ["tools", "subprocess"];
/** Validate and default plugin configuration. */
const Config = z.object({
	ffmpegPath: z.string().default("ffmpeg"),
	ffprobePath: z.string().default("ffprobe"),
	commandTimeoutMs: z.number().min(1).max(36e5).default(3e5),
	terminationGraceMs: z.number().min(1).max(6e4).default(5e3),
	outputMaxBytes: z.number().min(1).max(67108864).default(1048576),
	minTracksPerEpisode: z.number().min(1).max(64).default(DEFAULT_BGM_BATCH_POLICY.minTracksPerEpisode),
	maxEpisodesPerTrack: z.number().min(1).max(64).default(DEFAULT_BGM_BATCH_POLICY.maxEpisodesPerTrack),
	freshTracksPerEpisode: z.number().min(0).max(64).default(DEFAULT_BGM_BATCH_POLICY.freshTracksPerEpisode),
	boundaryToleranceSeconds: z.number().min(0).max(10).default(DEFAULT_BGM_BATCH_POLICY.boundaryToleranceSeconds)
});
const RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		method: {
			type: "string",
			required: true,
			enum: [
				"preview",
				"compose",
				"verify"
			]
		},
		episode: {
			type: "string",
			required: true
		},
		project: {
			type: "string",
			required: true
		},
		plan: {
			type: "string",
			required: true
		},
		timeline: {
			type: "string",
			required: true
		},
		output: {
			type: "string",
			required: true
		},
		report: {
			type: "string",
			required: true
		},
		body_duration_seconds: {
			type: "number",
			required: true
		},
		crossfade_seconds: {
			type: "number",
			required: true
		},
		segments: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					track: {
						type: "string",
						required: true,
						description: "计划里的曲目名。"
					},
					source: {
						type: "string",
						required: true,
						description: "源曲绝对路径。"
					},
					source_sha256: {
						type: "string",
						required: true,
						description: "实际源文件 SHA-256。"
					},
					start_seconds: {
						type: "number",
						required: true,
						description: "正文时间线起点。"
					},
					end_seconds: {
						type: "number",
						required: true,
						description: "正文时间线终点。"
					},
					reason: {
						type: "string",
						required: true,
						description: "Agent 记录的剧情选曲理由。"
					},
					input_duration_seconds: {
						type: "number",
						required: true,
						description: "交叉淡化前消耗的源曲长度。"
					},
					source_start_seconds: {
						type: "number",
						required: true,
						description: "源曲实际起播点。"
					},
					source_start_kind: {
						type: "string",
						required: true,
						enum: ["explicit", "onset"],
						description: "explicit=计划指定；onset=在 1–5 秒窗口检测首个可听起音。"
					},
					source_mean_db: {
						type: "number",
						required: true,
						description: "源窗口实测平均响度。"
					},
					applied_gain_db: {
						type: "number",
						required: true,
						description: "应用的响度增益，自动提升不超过 9 dB。"
					},
					valence: {
						type: "number",
						description: "计划可选：bgm_match 返回的实际愉悦度。"
					},
					arousal: {
						type: "number",
						description: "计划可选：bgm_match 返回的实际能量。"
					}
				}
			}
		},
		repeated_sequence_episodes: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		batch_episodes: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "本批参与跨集复用核对的集号（来自计划同目录的全部计划文件）。"
		},
		policy_findings: {
			type: "array",
			required: true,
			description: "本计划违反的批次选曲规则，每条含规则号、现状与改法；合规时为空。不拦截调用。",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					rule: {
						type: "string",
						required: true,
						description: "规则号：R1 每集曲目数、R2 集内重复、R3 单曲集数、R4 全新曲目、R5 切点。"
					},
					detail: {
						type: "string",
						required: true,
						description: "这条规则现在违反成什么样。"
					},
					fix: {
						type: "string",
						required: true,
						description: "该改什么：换哪几首、切点移到哪。"
					}
				}
			}
		},
		media: {
			type: "object",
			required: true,
			additionalProperties: false,
			properties: {
				codec: {
					type: "string",
					required: true
				},
				sample_rate: {
					type: "integer",
					required: true
				},
				channels: {
					type: "integer",
					required: true
				},
				duration_seconds: {
					type: "number",
					required: true
				},
				size_bytes: {
					type: "integer",
					required: true
				},
				sha256: {
					type: "string",
					required: true
				}
			}
		}
	}
};
const DESCRIPTION = "短剧整集 BGM 合成工具；只执行 Agent 已确认的 episodes/segments 计划，不选曲、不替代试听。可先用 bgm_match 获取带实测愉悦度/能量的候选，再由 Agent 按剧情选择曲目、切点和理由并写入计划。preview=安全预检：验证时间线、来源和完整连续覆盖，检测 1–5 秒内的起音，测量源窗口平均响度并计算目标 -17.5 dB、最大 +9 dB 的增益，不写正式产物。compose=按计划截取源曲，以计划 crossfade_seconds（默认 1.5 秒）交叉淡化，首尾淡入淡出，输出 48kHz 双声道 pcm_s16le WAV；先在同目录暂存并 ffprobe 回读，整批成功后才无覆盖发布 WAV 与 generation.json，失败会清理暂存文件。verify=只回读已有 WAV 的编码、采样率、声道、时长、大小和 SHA-256，不读取源曲、不重写文件，segments 为空。**跨集复用规则以 policy_findings 返回，不拦截调用；读到了就必须照 fix 改完再交付**：每集至少 2 首不同曲目（R1）、一集内不得重复同一首（R2）、整批之内同一首最多出现在 2 集（R3）、每集至少 1 首是本批其它集没用过的（R4）、每个切点必须落在镜头包边界上（R5，容差 0.05 秒）。批次 = 计划文件所在目录里所有含 episodes 数组的 JSON（通常 episodes/segments/*.json），因此同目录放不相关的 JSON 没关系，但读不动的文件会直接报错；返回的 batch_episodes 就是本次核对过的集号。同一首曲子的身份按解析后的绝对 source 路径判定，track 只当展示名。阈值是部署配置项（minTracksPerEpisode、maxEpisodesPerTrack、freshTracksPerEpisode、boundaryToleranceSeconds）。compose 返回的 output 传给 drama_render.bgm，同一 plan 传给 drama_render.bgm_plan。本工具不依赖 bgm_match；bgm_match 的 m-a-p/MERT-v1-95M 骨干采用 CC-BY-NC-4.0，仅限非商业用途，只要使用其候选就必须遵守。";
/**
* Register the `drama_bgm` model tool.
* @param ctx - Host context carrying tool and subprocess services.
* @param config - Deployment executable and subprocess limits.
*/
function apply(ctx, config = {}) {
	const resolvedConfig = Config(config);
	ctx.tools.register(defineTool({
		name: "drama_bgm",
		description: DESCRIPTION,
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"preview",
					"compose",
					"verify"
				],
				description: "preview=预检且不发布；compose=合成并无覆盖发布；verify=核验已有 WAV。"
			},
			project: {
				type: "string",
				required: true,
				description: "短剧项目根目录。"
			},
			episode: {
				type: "integer",
				required: true,
				description: "正整数集号，内部补成两位。"
			},
			timeline: {
				type: "string",
				required: true,
				description: "项目内时间线 JSON，必须含 body_end，通常为 editing/<集>-timeline.json。"
			},
			plan: {
				type: "string",
				required: true,
				description: "项目内 episodes/segments BGM 计划 JSON；段落必须连续完整覆盖正文，跨集复用规则见 policy_findings（每集至少 2 首、集内不重复、单曲最多 2 集、至少 1 首全新、切点在镜头包边界）。"
			},
			output: {
				type: "string",
				description: "项目内 WAV 路径；省略为 audio/bgm/<集>.wav。"
			}
		},
		output: {
			schema: RESULT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args, exec) => await runDramaBgm(args, {
			ffmpegPath: resolvedConfig.ffmpegPath,
			ffprobePath: resolvedConfig.ffprobePath,
			channel: createSubprocessChannel(ctx.subprocess, resolve(args.project), resolvedConfig.commandTimeoutMs, resolvedConfig.terminationGraceMs, resolvedConfig.outputMaxBytes),
			signal: exec.signal,
			policy: {
				minTracksPerEpisode: resolvedConfig.minTracksPerEpisode,
				maxEpisodesPerTrack: resolvedConfig.maxEpisodesPerTrack,
				freshTracksPerEpisode: resolvedConfig.freshTracksPerEpisode,
				boundaryToleranceSeconds: resolvedConfig.boundaryToleranceSeconds
			}
		})
	}));
}
//#endregion
export { Config, apply, inject, name, runDramaBgm };
