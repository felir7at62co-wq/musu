import { dirname, isAbsolute, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
//#region lib/types/ffmpeg.js
/**
* The external-process edge of the renderer: one channel that starts a process,
* the ffmpeg and ffprobe wrappers built on it, and the error a failed command
* raises.
*
* Every other module takes a {@link MediaToolkit} and never starts a process
* itself, so a test substitutes one channel and exercises the whole pipeline
* without running ffmpeg.
*
* @module @deepseek-ai/dsh-tool-episode-render/ffmpeg
*/
/** Exit code reported for a process that ended without one, so a failure never reads as success. */
const UNKNOWN_EXIT_CODE = 127;
/** One external command that exited non-zero. */
var MediaCommandError = class extends Error {
	/** The executable that was started. */
	command;
	/** The arguments the executable received. */
	args;
	/** The exit code the command reported. */
	code;
	/** The last {@link STDERR_TAIL_CHARS} characters the command wrote to standard error. */
	stderr;
	/**
	* Record one failed command.
	* @param command - The executable that was started.
	* @param args - The arguments the executable received.
	* @param code - The exit code the command reported.
	* @param stderr - Everything the command wrote to standard error.
	*/
	constructor(command, args, code, stderr) {
		super(`${describeCommand(command, args)} 退出码 ${String(code)}：${stderr.slice(-4e3)}`);
		this.name = "MediaCommandError";
		this.command = command;
		this.args = args;
		this.code = code;
		this.stderr = stderr;
	}
};
/**
* Render one command line for a message or a log.
* @param command - The executable to start.
* @param args - The arguments the executable receives.
* @returns The command and its arguments separated by single spaces.
*/
function describeCommand(command, args) {
	return [command, ...args].join(" ");
}
/**
* Read one process exit code.
*
* A process that ended without one — killed by a signal rather than exiting —
* reports {@link UNKNOWN_EXIT_CODE}, because a null code must never be read as a
* successful run.
* @param code - The code Node reported, or null when the process did not exit on its own.
* @returns The exit code, or 127 when there is none.
*/
function exitCodeOf(code) {
	return code ?? UNKNOWN_EXIT_CODE;
}
/**
* Build a process channel that captures output through ordinary files.
*
* The DSH Windows sandbox rejects Node child-process pipes with EPERM. File
* descriptors preserve the same capture contract without named pipes.
* @returns A channel that collects stdout/stderr and removes its temporary files after each command.
*/
function createFileCaptureChannel() {
	return { run: async (command, args) => {
		const directory = await mkdtemp(join(tmpdir(), "dsh-drama-render-"));
		const stdoutPath = join(directory, "stdout.txt");
		const stderrPath = join(directory, "stderr.txt");
		let stdoutFile;
		let stderrFile;
		try {
			stdoutFile = await open(stdoutPath, "w");
			stderrFile = await open(stderrPath, "w");
			const outcome = await new Promise((resolve) => {
				const child = spawn(command, [...args], {
					stdio: [
						"ignore",
						stdoutFile?.fd,
						stderrFile?.fd
					],
					windowsHide: true
				});
				let settled = false;
				const settle = (code, spawnError = "") => {
					if (settled) return;
					settled = true;
					resolve({
						code,
						spawnError
					});
				};
				child.on("error", (error) => {
					settle(UNKNOWN_EXIT_CODE, error.message);
				});
				child.on("close", (code) => {
					settle(exitCodeOf(code));
				});
			});
			await stdoutFile.close();
			await stderrFile.close();
			const stdout = await readFile(stdoutPath, "utf8");
			const stderr = `${await readFile(stderrPath, "utf8")}${outcome.spawnError}`;
			return {
				code: outcome.code,
				stdout,
				stderr
			};
		} finally {
			await stdoutFile?.close().catch(() => void 0);
			await stderrFile?.close().catch(() => void 0);
			await rm(directory, {
				recursive: true,
				force: true
			});
		}
	} };
}
/**
* Assemble the toolkit one call uses.
* @param settings - The resolved binaries and an optional channel override.
* @param settings.ffmpeg - The ffmpeg executable to start.
* @param settings.ffprobe - The ffprobe executable to start.
* @param settings.channel - The process channel; the file-capture channel when omitted.
* @returns A toolkit every pipeline step can share.
*/
function createMediaToolkit(settings) {
	return {
		ffmpeg: settings.ffmpeg,
		ffprobe: settings.ffprobe,
		channel: settings.channel ?? createFileCaptureChannel()
	};
}
/**
* Start ffmpeg and return its outcome without judging the exit code.
* @param toolkit - The binaries and channel to use.
* @param args - Arguments handed to ffmpeg unchanged.
* @returns The exit code and both captured streams.
*/
async function captureFfmpeg(toolkit, args) {
	return await toolkit.channel.run(toolkit.ffmpeg, args);
}
/**
* Run one ffmpeg command and fail loud when it exits non-zero.
*
* An encode that fails must never look like a finished render, so this is the
* only form the pipeline uses for work whose output it then trusts. The full
* argument list is part of the message: a failed filter graph is read from the
* command, not guessed from the exit code.
* @param toolkit - The binaries and channel to use.
* @param args - Arguments handed to ffmpeg unchanged.
* @throws {MediaCommandError} When ffmpeg exits non-zero.
*/
async function runFfmpeg(toolkit, args) {
	const outcome = await captureFfmpeg(toolkit, args);
	if (outcome.code !== 0) throw new MediaCommandError(toolkit.ffmpeg, args, outcome.code, outcome.stderr);
}
/** Read a numeric probe field, tolerating the strings ffprobe emits. */
function probeNumber(value) {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return void 0;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/** Read a textual probe field. */
function probeText(value) {
	return typeof value === "string" ? value : "";
}
/**
* Report whether one parsed report carries the streams array this package reads.
*
* `JSON.parse` returns `unknown` here: a report from another tool, a truncated
* file, or an error page must fail the caller's own diagnostic rather than
* reaching the stream loop as a missing field.
* @param value - The parsed report.
* @returns Whether the value is an object carrying a streams array.
*/
function hasStreamsArray(value) {
	return typeof value === "object" && value !== null && Array.isArray(value.streams);
}
/**
* Probe one media file through ffprobe.
* @param toolkit - The binaries and channel to use.
* @param file - Absolute path of the file to probe.
* @returns The streams plus the container facts this package reads.
* @throws {MediaCommandError} When ffprobe exits non-zero.
* @throws {Error} When ffprobe's report is not the JSON object this package expects.
*/
async function probeMedia(toolkit, file) {
	const args = [
		"-v",
		"error",
		"-show_streams",
		"-show_format",
		"-of",
		"json",
		file
	];
	const outcome = await toolkit.channel.run(toolkit.ffprobe, args);
	if (outcome.code !== 0) throw new MediaCommandError(toolkit.ffprobe, args, outcome.code, outcome.stderr);
	let document;
	try {
		document = JSON.parse(outcome.stdout);
	} catch (error) {
		throw new Error(`ffprobe 对 ${file} 没有返回 JSON，无法读取媒体参数。请确认该文件是完整可解码的 MP4，必要时用 ffmpeg -err_detect explode 复跑一次定位损坏帧。`, { cause: error });
	}
	if (!hasStreamsArray(document)) throw new Error(`ffprobe 对 ${file} 的报告里没有 streams 数组，无法读取媒体参数。请确认文件没有被截断；重新导出该文件后再试。`);
	return {
		streams: document.streams.map((stream) => {
			const width = probeNumber(stream.width);
			const height = probeNumber(stream.height);
			const avgFrameRate = probeText(stream.avg_frame_rate);
			const rFrameRate = probeText(stream.r_frame_rate);
			const sampleRate = probeNumber(stream.sample_rate);
			const channels = probeNumber(stream.channels);
			return {
				codecType: probeText(stream.codec_type),
				codecName: probeText(stream.codec_name),
				...width === void 0 ? {} : { width },
				...height === void 0 ? {} : { height },
				...avgFrameRate === "" ? {} : { avgFrameRate },
				...rFrameRate === "" ? {} : { rFrameRate },
				...sampleRate === void 0 ? {} : { sampleRate },
				...channels === void 0 ? {} : { channels }
			};
		}),
		durationSeconds: probeNumber(document.format?.duration) ?? 0,
		sizeBytes: probeNumber(document.format?.size) ?? 0,
		bitRateBps: probeNumber(document.format?.bit_rate) ?? 0
	};
}
/**
* Read the first stream of one type.
* @param media - The probed media.
* @param codecType - `video` or `audio`.
* @returns The first matching stream, or `undefined` when the file has none.
*/
function firstStreamOfType(media, codecType) {
	return media.streams.find((stream) => stream.codecType === codecType);
}
/**
* Read a frame rate expressed as ffprobe's `numerator/denominator`.
* @param stream - The video stream to read.
* @returns Frames per second, or 0 when neither field parses.
*/
function frameRateOf(stream) {
	if (stream === void 0) return 0;
	const parts = (stream.avgFrameRate ?? stream.rFrameRate ?? "").split("/");
	const top = Number(parts[0]);
	const bottom = Number(parts[1]);
	if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return 0;
	return top / bottom;
}
/**
* Convert one path for use inside an ffmpeg filter argument.
*
* ffmpeg's filter parser treats `:` as an option separator and `\` as an escape,
* so a Windows path reaches libass as `C\:/Windows/Fonts`.
* @param path - The filesystem path to convert.
* @returns The path with forward slashes and an escaped drive colon.
*/
function escapeFilterPath(path) {
	return path.split("\\").join("/").replace(/:/g, "\\:");
}
//#endregion
//#region lib/types/cache.js
/** Content identities for prepared sources and successful per-shot encodes. */
/**
* Hash a local media file without buffering the whole video.
* @param path - File whose bytes identify the selected source.
* @returns Lowercase SHA-256 digest.
*/
async function fileSha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
/**
* Read an optional cache identity; unreadable files remain errors.
* @param path - The identity sidecar.
* @returns The saved identity, or empty on a cache miss.
*/
async function readCacheIdentity(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return "";
		throw error;
	}
}
//#endregion
//#region lib/types/video.js
/** Project-local, reversible user bans keyed by exact video bytes; independent of source review. */
const SHA256 = /^[a-f0-9]{64}$/u;
function labelsValid(value) {
	return Array.isArray(value) && value.length > 0 && value.every((label) => typeof label === "string" && label.trim().length > 0);
}
/**
* Read all decisions, refusing corrupt or unsupported manifests rather than treating them as empty.
* @param project - Project root.
* @returns Validated version decisions; absent manifest means no decisions.
*/
async function readVideoBans(project) {
	const path = resolve(project, "video-bans.json");
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	try {
		const document = JSON.parse(text.replace(/^\ufeff/u, ""));
		if (document?.version !== 1 || !Array.isArray(document.videos)) throw new Error("version/videos");
		const hashes = /* @__PURE__ */ new Set();
		for (const value of document.videos) {
			const row = value;
			if (row === null || typeof row !== "object" || typeof row.sha256 !== "string" || !SHA256.test(row.sha256) || hashes.has(row.sha256) || !labelsValid(row.labels) || typeof row.reason !== "string" || typeof row.banned !== "boolean" || typeof row.video !== "string" || !isAbsolute(row.video) || typeof row.updated_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(row.updated_at) || !Number.isFinite(Date.parse(row.updated_at))) throw new Error("invalid video decision");
			hashes.add(row.sha256);
		}
		return document.videos;
	} catch (error) {
		throw new Error(`禁用清单损坏或版本不支持：${path}。请修复清单后重试；不会忽略或覆盖旧数据。`, { cause: error });
	}
}
/**
* Refuse exact selected bytes that the user disabled, including same-byte copies.
* @param project - Project root owning the decisions.
* @param videos - Actual files about to be consumed.
* @returns Resolves only when none of the selected versions is banned.
*/
async function assertVideosAllowed(project, videos) {
	const bans = (await readVideoBans(project)).filter((row) => row.banned);
	if (bans.length === 0) return;
	for (const video of new Set(videos)) rejectBannedHash(bans, await fileSha256(video), video);
}
function rejectBannedHash(bans, sha256, label) {
	const banned = bans.find((row) => row.banned && row.sha256 === sha256);
	if (banned !== void 0) throw new Error(`视频版本已禁用：${label} [${sha256}]；labels=${banned.labels.join("、")}；reason=${banned.reason}。请选择其他版本；确认误标或收到解除要求后可调用 drama_video unban，不要仅为让导出通过而解除；解除禁用不代表审核通过。`);
}
/**
* Recheck versions actually consumed earlier in a render, even if their paths were subsequently replaced.
* @param project - Project root owning decisions.
* @param hashes - Source hashes computed by this render, never model-supplied identities.
*/
async function assertVideoHashesAllowed(project, hashes) {
	const bans = await readVideoBans(project);
	for (const hash of hashes) rejectBannedHash(bans, hash, "本次渲染已选源");
}
/**
* Query or atomically update a project decision; ban always hashes a readable local video.
* @param args - User-requested operation and local project/video selection.
* @returns Latest labels and reason, with review explicitly unassessed.
*/
async function runDramaVideo(args) {
	if (typeof args.project !== "string" || args.project.trim() === "") throw new Error("project 必须是项目目录。");
	const project = resolve(args.project);
	if (!(await stat(project)).isDirectory()) throw new Error("project 必须是项目目录。");
	const manifest_path = resolve(project, "video-bans.json");
	if (![
		"ban",
		"unban",
		"list",
		"inspect"
	].includes(args.method)) throw new Error("不支持的 drama_video method。");
	if (args.method === "ban" && !labelsValid(args.labels)) throw new Error("ban 的 labels 必须是至少含一个非空字符串的列表。");
	if (args.reason !== void 0 && typeof args.reason !== "string") throw new Error("reason 必须是字符串。");
	if (args.method === "ban" && (args.video === void 0 || args.sha256 !== void 0)) throw new Error("ban 必须指定现有本地 video，不接受 sha256 代替。");
	let sha256 = "";
	let video = "";
	if (args.method !== "list") {
		if (args.video === void 0 === (args.sha256 === void 0)) throw new Error("必须且只能指定 video 或 sha256。");
		if (args.video !== void 0) {
			if (typeof args.video !== "string" || args.video.trim() === "") throw new Error("video 必须是本地视频路径。");
			video = resolve(project, args.video);
			if (!(await stat(video)).isFile()) throw new Error("video 必须是本地文件。");
			sha256 = await fileSha256(video);
		} else {
			if (typeof args.sha256 !== "string" || !SHA256.test(args.sha256)) throw new Error("sha256 必须是清单返回的64位小写十六进制值。");
			sha256 = args.sha256;
		}
	}
	const operation = async () => {
		const videos = await readVideoBans(project);
		let record = videos.find((row) => row.sha256 === sha256);
		if (args.method === "ban") {
			if (!labelsValid(args.labels)) throw new Error("ban 的 labels 必须是至少含一个非空字符串的列表。");
			const next = {
				sha256,
				video,
				labels: [...new Set(args.labels.map((label) => label.trim()))],
				reason: args.reason ?? "",
				banned: true,
				updated_at: (/* @__PURE__ */ new Date()).toISOString()
			};
			if (record === void 0) videos.push(next);
			else videos[videos.indexOf(record)] = next;
			record = next;
		} else if (args.method === "unban" && record !== void 0) {
			record.banned = false;
			record.updated_at = (/* @__PURE__ */ new Date()).toISOString();
		}
		if (args.method === "ban" || args.method === "unban" && record !== void 0) await writeFileAtomic(manifest_path, `${JSON.stringify({
			version: 1,
			videos
		}, null, 2)}\n`, { mode: 384 });
		return {
			method: args.method,
			project,
			manifest_path,
			sha256,
			banned: args.method === "list" ? videos.some((row) => row.banned) : record?.banned ?? false,
			labels: record?.labels ?? [],
			reason: record?.reason ?? "",
			review_status: "not_assessed",
			videos: args.method === "list" ? videos : []
		};
	};
	return args.method === "ban" || args.method === "unban" ? await withFileLock(manifest_path, operation) : await operation();
}
/**
* Register the reversible video decision tool in the renderer's owning fiber.
* @param ctx - Context carrying the tool registry.
*/
function registerDramaVideo(ctx) {
	ctx.tools.register(defineTool({
		name: "drama_video",
		description: "按用户决定禁用或解除禁用具体视频版本。ban 必须提供本地 video 和至少一个 labels 标签（如人物对调、字幕错误），reason 可选，不要求审图证据。内部按 SHA256 标识，同字节副本共享禁用，新生成不同字节不受影响。unban 不等于审核通过；list/inspect 可读标签和原因。只在 drama_render prepare/render 拦截，verify 报告风险不删文件；不拦截通用 ffmpeg。",
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"ban",
					"unban",
					"list",
					"inspect"
				]
			},
			project: {
				type: "string",
				required: true,
				description: "现有项目目录，禁用清单持久化在该目录。"
			},
			video: {
				type: "string",
				description: "本地视频路径，相对项目或绝对路径；ban 必填，内部计算 SHA256。"
			},
			sha256: {
				type: "string",
				description: "仅 unban/inspect 可用清单返回的 SHA256 代替已不存在的 video，二者互斥。"
			},
			labels: {
				type: "array",
				items: { type: "string" },
				description: "ban 必填：至少一个非空标签，如人物对调、字幕错误。"
			},
			reason: {
				type: "string",
				description: "ban 可选：用户禁用原因；不是审图证据。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					method: {
						type: "string",
						required: true
					},
					project: {
						type: "string",
						required: true
					},
					manifest_path: {
						type: "string",
						required: true
					},
					sha256: {
						type: "string",
						required: true
					},
					banned: {
						type: "boolean",
						required: true
					},
					labels: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					reason: {
						type: "string",
						required: true
					},
					review_status: {
						type: "string",
						required: true,
						enum: ["not_assessed"]
					},
					videos: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								sha256: {
									type: "string",
									required: true
								},
								video: {
									type: "string",
									required: true
								},
								labels: {
									type: "array",
									required: true,
									items: { type: "string" }
								},
								reason: {
									type: "string",
									required: true
								},
								banned: {
									type: "boolean",
									required: true
								},
								updated_at: {
									type: "string",
									required: true
								}
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => await runDramaVideo(args)
	}));
}
//#endregion
//#region lib/types/paths.js
/**
* Where one episode's render inputs and outputs live under a project root.
*
* The layout is the one the short-drama pipeline already reads and writes —
* `video/<集>/shot_00N.mp4` for the shots the renderer consumes, `audio/<集>.wav`
* for the episode's own master, `editing/` for the timeline and the subtitle the
* renderer burns, and `exports/` for the delivered file and its cache. Naming it
* once keeps `prepare`, `render`, and `verify` addressing the same files.
*
* @module @deepseek-ai/dsh-tool-episode-render/paths
*/
/**
* Report whether one path exists.
*
* Only a genuinely absent path is `false`. Any other stat failure — a permission
* error, an unusable path — is rethrown, so a broken directory never reads as a
* cache miss and a broken tail-frame path never reads as an empty seek.
* @param path - The path to stat.
* @returns Whether the path exists.
* @throws {Error} When the path exists but cannot be stat'ed.
*/
async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
/**
* Pad one episode number to the two digits every project path uses.
* @param episode - The episode number.
* @returns The number padded with a leading zero when it is below ten.
*/
function episodeNumberOf(episode) {
	return String(episode).padStart(2, "0");
}
/**
* Name one shot's file inside an episode's video directory.
* @param shot - The shot number.
* @returns `shot_001.mp4`.
*/
function shotFileName(shot) {
	return `shot_${String(shot).padStart(3, "0")}.mp4`;
}
/**
* Resolve every path one episode's render touches.
* @param project - Absolute project root.
* @param episode - The two-digit episode number.
* @returns The resolved layout.
*/
function episodePaths(project, episode) {
	return {
		project,
		episode,
		videoDir: join(project, "video", episode),
		masterAudio: join(project, "audio", `${episode}.wav`),
		timeline: join(project, "editing", `${episode}-timeline.json`),
		sources: join(project, "editing", `${episode}-sources.json`),
		subtitle: join(project, "editing", `${episode}.srt`),
		output: join(project, "exports", `${episode}.mp4`),
		cacheDir: join(project, "exports", ".render_cache", episode),
		renderLog: join(project, "exports", ".render_cache", episode, "render.log")
	};
}
//#endregion
//#region lib/types/delivery.js
/**
* The fixed delivery style: picture geometry, rate control, subtitle style,
* ending effect, and the audio mix graph.
*
* These values are the operator-approved delivery specification, not
* deployment-varying choices, so they live here as constants and every method
* builds its commands from them. What does vary per deployment — the binaries,
* the two audio gains, the font directory and families — is validated by the
* plugin's Config.
*
* @module @deepseek-ai/dsh-tool-episode-render/delivery
*/
/** Delivered picture width in pixels. */
const DELIVERY_WIDTH = 1440;
/** Delivered picture height in pixels. */
const DELIVERY_HEIGHT = 2560;
/**
* Overall bitrate floor a delivered episode must reach.
*
* A render that lands below this is a failed delivery even when every stream is
* correct: the platform re-encodes what it receives, and a starved master loses
* the detail the 1440x2560 master exists to carry.
*/
const MIN_BITRATE_BPS = 46e5;
/** How much of the ending effect's own timeline one second of the freeze consumes. */
const EFFECT_SPEED = "0.729";
/** The ending effect's blend opacity over the frozen frame. */
const EFFECT_BLEND_OPACITY = "0.90";
/** Where the AI-content mark sits on the 1080x1920 script canvas. */
const WATERMARK_POSITION = "{\\an3\\pos(1025,1810)}";
/** The text the delivery spec requires in the bottom-right corner. */
const WATERMARK_TEXT = "内容由AI生成";
/** Keyframe interval in frames. */
const KEYFRAME_INTERVAL = 120;
/**
* Compose the ASS styles and event format with deployment-selected fonts.
* @param settings - Font families validated by the plugin Config.
* @returns The ASS header, including the event format line.
*/
function buildAssHeader(settings) {
	return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,${settings.subtitleFontFamily},68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,-2,0,1,7,0,2,40,40,520,1
Style: Watermark,${settings.watermarkFontFamily},44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,20,20,20,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;
}
/**
* The filter every body clip and the ending frame pass through.
*
* `increase` plus `crop` fills the delivery frame from any source aspect ratio
* without letterboxing, and the pixel format is fixed to what the encoder and
* the blend expect.
* @param pixelFormat - The format the chain ends in; `gbrp` when the frame is blended instead of encoded.
* @returns The scale, crop, frame-rate, and pixel-format chain.
*/
function deliveryScaleFilter(pixelFormat = "yuv420p") {
	return `scale=${String(DELIVERY_WIDTH)}:${String(DELIVERY_HEIGHT)}:force_original_aspect_ratio=increase,crop=${String(DELIVERY_WIDTH)}:${String(DELIVERY_HEIGHT)},fps=${String(60)},format=${pixelFormat}`;
}
/**
* The rate-control and profile arguments one encoder takes.
* @param encoder - `h264_nvenc` or `libx264`.
* @returns The arguments that follow `-c:v <encoder>`.
*/
function encoderArguments(encoder) {
	const rateControl = [
		"-b:v",
		"24M",
		"-maxrate",
		"30M",
		"-bufsize",
		"48M",
		"-g",
		String(KEYFRAME_INTERVAL),
		"-profile:v",
		"high",
		"-level",
		"5.1"
	];
	return encoder === "h264_nvenc" ? [
		"-preset",
		"p5",
		"-rc",
		"vbr",
		"-cq",
		"19",
		...rateControl
	] : [
		"-preset",
		"medium",
		...rateControl
	];
}
/** The lavfi source the encoder probe encodes one frame of. */
const ENCODER_PROBE_SOURCE = "color=black:s=256x256:d=0.1";
/**
* The filter graph that turns the frozen tail frame and the ending effect into
* the ending clip.
*
* The effect is sped up to {@link EFFECT_SPEED}, interpolated to 120 fps and
* blended back to 60, then screen-blended over the freeze at
* {@link EFFECT_BLEND_OPACITY}; the freeze itself is a single still, so the
* ending's length is exactly the trim, independent of the effect's own duration.
* @returns The filter graph, whose only output pad is `[v]`.
*/
function endingEffectFilter() {
	return `[0:v]${deliveryScaleFilter("gbrp")}[base];[1:v]setpts=(PTS-STARTPTS)/${EFFECT_SPEED},scale=540:960:force_original_aspect_ratio=increase,crop=540:960,minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir,tmix=frames=2:weights='1 1',tpad=stop_mode=add:stop_duration=${2 .toFixed(3)}:color=black,trim=0:${2 .toFixed(3)},fps=${String(60)},scale=${String(DELIVERY_WIDTH)}:${String(DELIVERY_HEIGHT)}:flags=lanczos,eq=contrast=1.28:brightness=-0.14:saturation=1.15,format=gbrp[fx];[base][fx]blend=all_mode=screen:all_opacity=${EFFECT_BLEND_OPACITY}:shortest=1,format=yuv420p[v]`;
}
/**
* The filter that burns the ASS script into the picture.
*
* The frame is doubled before libass runs and halved afterwards, so the 1080x1920
* script canvas is rasterized at twice its declared size; the delivered picture
* keeps the script's own geometry.
* @param assPath - Absolute path of the ASS script to burn.
* @param fontsDir - Directory libass resolves the style's font from.
* @returns The scale, subtitles, and scale chain.
*/
function subtitleBurnFilter(assPath, fontsDir) {
	return `scale=${String(DELIVERY_WIDTH * 2)}:${String(DELIVERY_HEIGHT * 2)}:flags=lanczos,ass='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}',scale=${String(DELIVERY_WIDTH)}:${String(DELIVERY_HEIGHT)}:flags=lanczos`;
}
/**
* The graph that mixes the episode's own master, the BGM bed, and the ending
* sound into the delivered audio.
*
* Input 0 is the picture, 1 the master audio, 2 the BGM, and 3 the ending sound;
* the ending is delayed to the body end and never mixed over the body, the BGM is
* cut at the body end rather than run under the ending, and the master is padded
* to the total so `amix` cannot end early. `normalize=0` keeps every gain the
* caller's own, and the limiter is the delivery spec's final ceiling.
* @param spec - The boundaries and gains this mix uses.
* @returns The filter graph, whose only output pad is `[a]`.
*/
function audioMixFilter(spec) {
	const total = spec.totalSeconds.toFixed(6);
	const body = spec.bodyEndSeconds.toFixed(6);
	const delayMs = Math.round(spec.bodyEndSeconds * 1e3);
	return `[1:a]apad,atrim=0:${total},volume=${String(spec.masterVolume)}[a0];[2:a]atrim=0:${body},volume=${String(spec.bgmVolume)}[a1];[3:a]atrim=0:${spec.endingSeconds.toFixed(6)},adelay=${String(delayMs)}|${String(delayMs)},volume=1[a2];[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,atrim=0:${total},alimiter=limit=0.95:level=false[a]`;
}
/** Split decimal seconds into the three ASS fields. */
function splitAssTime(seconds) {
	return {
		hours: Math.floor(seconds / 3600),
		minutes: Math.floor(seconds % 3600 / 60),
		seconds: (seconds % 60).toFixed(2).padStart(5, "0")
	};
}
/**
* Format one ASS timestamp.
* @param seconds - Seconds from the episode start.
* @returns `H:MM:SS.cc`, the form the ASS event lines carry.
*/
function formatAssTime(seconds) {
	const { hours, minutes, seconds: rest } = splitAssTime(seconds);
	return `${String(hours)}:${String(minutes).padStart(2, "0")}:${rest}`;
}
/**
* Escape one cue's text for the ASS event line.
*
* Braces open an override block in ASS, so a literal brace in the subtitle would
* otherwise be read as markup and silently drop the text around it.
* @param text - The cue text.
* @returns The text with braces replaced by full-width parentheses.
*/
function escapeAssText(text) {
	return text.replace(/\{/g, "（").replace(/\}/g, "）");
}
//#endregion
//#region lib/types/subtitles.js
/**
* Subtitle input: reading the SRT the pipeline produced and composing the ASS
* script the delivery style burns in.
*
* The burned-in subtitle is part of the delivered picture, so its style is the
* delivery specification rather than a tool parameter: size 68 with -2 spacing
* and a 7px black outline, bottom-centred on a 1080x1920 canvas, plus the single
* bottom-right `内容由AI生成` mark.
*
* @module @deepseek-ai/dsh-tool-episode-render/subtitles
*/
/** The watermark event runs the whole programme; ASS has no "until the end" timestamp. */
const WATERMARK_END = "9:59:59.00";
/**
* Parse one SRT timestamp.
* @param value - A timestamp such as `00:01:02,500` or `00:01:02.500`.
* @param path - The subtitle path, for diagnostics.
* @returns Seconds from the episode start.
* @throws {Error} When the timestamp is not `HH:MM:SS,mmm`.
*/
function parseSrtTime(value, path) {
	const parts = value.trim().replace(",", ".").split(":");
	const [hours, minutes, seconds] = parts;
	if (parts.length !== 3 || hours === void 0 || minutes === void 0 || seconds === void 0) throw new Error(`${path}: 字幕时间码 "${value}" 不是 HH:MM:SS,mmm 形式。请修正该条字幕的时间行（形如 00:01:02,500 --> 00:01:04,000）后重试。`);
	const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
	if (!Number.isFinite(total)) throw new Error(`${path}: 字幕时间码 "${value}" 含有非数字字段。请修正该条字幕的时间行后重试。`);
	return total;
}
/**
* Parse one SRT document.
*
* Blocks without a timing line are skipped rather than rejected: an SRT that
* carries a stray title block is common and harmless. A block whose timing line
* exists but does not parse is a real defect and throws, because a cue with a
* wrong time is burned into the delivery.
* @param text - The whole SRT document.
* @param path - The subtitle path, for diagnostics.
* @returns Every cue, in file order, numbered from 1.
* @throws {Error} When a cue's timing line is malformed.
*/
function parseSrtDocument(text, path) {
	const normalized = text.replace(/^\ufeff/, "").replace(/\r\n/g, "\n");
	const cues = [];
	for (const block of normalized.trim().split(/\n\s*\n/)) {
		const lines = block.split("\n");
		const timing = lines[1] ?? "";
		if (lines.length < 3 || !timing.includes("-->")) continue;
		const [start = "", end = ""] = timing.split("-->");
		cues.push({
			index: cues.length + 1,
			startSeconds: parseSrtTime(start, path),
			endSeconds: parseSrtTime(end, path),
			text: lines.slice(2).join("")
		});
	}
	return cues;
}
/**
* Read and parse one subtitle file.
* @param path - Absolute path of the SRT.
* @returns Every cue, in file order.
* @throws {Error} When the file cannot be read or a cue's timing line is malformed.
*/
async function readSubtitleCues(path) {
	return parseSrtDocument(await readFile(path, "utf8"), path);
}
/**
* Format one SRT timestamp.
* @param seconds - Seconds from the episode start.
* @returns `HH:MM:SS,mmm`.
*/
function formatSrtTime(seconds) {
	const total = Math.max(0, Math.round(seconds * 1e3));
	const milliseconds = total % 1e3;
	const whole = (total - milliseconds) / 1e3;
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)},${pad(milliseconds, 3)}`;
}
/**
* Compose one SRT document from placed cues.
*
* The written file is the artifact `prepare` installs and `render` burns, and it
* stays plain SRT so the operator can hand-edit a line before the delivery is
* encoded.
* @param cues - The cues to write, in delivery order.
* @returns The complete SRT document, one block per cue.
*/
function formatSrtDocument(cues) {
	return `${cues.map((cue) => `${String(cue.index)}\n${formatSrtTime(cue.startSeconds)} --> ${formatSrtTime(cue.endSeconds)}\n` + cue.text).join("\n\n")}\n`;
}
/**
* Compose the ASS script for one episode.
*
* Every cue becomes a `Default` dialogue line and the delivery spec's AI-content
* mark becomes the single `Watermark` line, so the burn-in carries both the
* operator's subtitle style and the platform's declaration in one file.
* @param cues - The cues to burn, in file order.
* @param settings - Font families validated by the plugin Config.
* @returns The complete ASS document.
*/
function buildAssDocument(cues, settings) {
	const events = cues.map((cue) => `Dialogue: 0,${formatAssTime(cue.startSeconds)},${formatAssTime(cue.endSeconds)},Default,,0,0,0,,` + escapeAssText(cue.text));
	events.push(`Dialogue: 1,0:00:00.00,${WATERMARK_END},Watermark,,0,0,0,,${WATERMARK_POSITION}${WATERMARK_TEXT}`);
	return `${buildAssHeader(settings)}${events.join("\n")}\n`;
}
//#endregion
//#region lib/types/timeline.js
/**
* The episode timeline: reading the JSON the renderer lays out, selecting the
* body clips one render covers, and deriving the two boundaries every later step
* cuts at.
*
* The timeline is the single clock. Picture and sound both follow it, and the
* ending starts where its last body clip ends, so a timeline whose clips overlap
* or whose `body_end` disagrees with the clips is rejected here rather than
* discovered as an audible drift in the delivered file.
*
* @module @deepseek-ai/dsh-tool-episode-render/timeline
*/
/** Microseconds in one second. */
const MICROSECONDS_PER_SECOND$2 = 1e6;
/** Decimal places `body_end` is written with, matching the timeline format. */
const BODY_END_DECIMALS = 6;
/** Read one numeric field of a clip, rejecting anything that is not a finite number. */
function readInteger(source, field, path, index) {
	const value = source[field];
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw new Error(`${path}：第 ${String(index + 1)} 个 clip 的 ${field} 必须是非负整数微秒，收到 ${JSON.stringify(value)}。请重新生成时间线（prepare 会按真实视频时长写出 start_us 与 duration_us）。`);
	return value;
}
/**
* Read one timeline document.
* @param document - The parsed JSON value.
* @param path - The path the document came from, for diagnostics.
* @returns The clips in file order plus the body end they imply.
* @throws {Error} When `clips` is missing or a clip is not a well-formed non-negative integer row.
*/
function parseTimelineDocument(document, path) {
	if (typeof document !== "object" || document === null || !Array.isArray(document.clips)) throw new Error(`${path}: 时间线必须是 {"clips":[{"shot":1,"start_us":0,"duration_us":5050000}]}。请重新生成时间线，或把 prepare 的输出路径填给 timeline。`);
	const clips = document.clips.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) throw new Error(`${path}：第 ${String(index + 1)} 个 clip 不是对象。请提供 {"shot":N,"start_us":整数,"duration_us":整数} 形式的行。`);
		const row = entry;
		const shot = readInteger(row, "shot", path, index);
		if (shot < 1) throw new Error(`${path}：第 ${String(index + 1)} 个 clip 的 shot 必须从 1 开始，收到 ${String(shot)}。请按镜头号从 1 连续编号。`);
		return {
			shot,
			startUs: readInteger(row, "start_us", path, index),
			durationUs: readInteger(row, "duration_us", path, index)
		};
	});
	if (clips.length === 0) throw new Error(`${path}: 时间线没有任何 clip，无法渲染。请先用 prepare 由成片清单构建时间线。`);
	for (const clip of clips) if (clip.durationUs === 0) throw new Error(`${path}: 镜头 ${String(clip.shot)} 的 duration_us 是 0，无法编码零长片段。请确认该镜的成片文件没有被截断成空；必要时重新导出该镜。`);
	return {
		clips,
		bodyEndSeconds: bodyEndSecondsOf(clips)
	};
}
/**
* Derive the body end from a clip list.
*
* The body ends at the furthest clip end, not at the last row's end: a timeline
* whose rows are out of order still renders the whole programme.
* @param clips - The clips to measure.
* @returns Seconds from the episode start to the last body frame, rounded to six decimals.
*/
function bodyEndSecondsOf(clips) {
	const farthestUs = clips.reduce((end, clip) => Math.max(end, clip.startUs + clip.durationUs), 0);
	return Number((farthestUs / MICROSECONDS_PER_SECOND$2).toFixed(BODY_END_DECIMALS));
}
/**
* Read and parse one timeline file.
* @param path - Absolute path of the timeline JSON.
* @returns The parsed timeline.
* @throws {Error} When the file cannot be read, is not JSON, or is not a timeline document.
*/
async function readTimeline(path) {
	const text = await readTimelineText(path);
	let document;
	try {
		document = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path}: 时间线不是合法 JSON。请确认它是 UTF-8 的 {"clips":[...]} 文件，或用 prepare 重新生成。`, { cause: error });
	}
	return parseTimelineDocument(document, path);
}
/** Read one file as UTF-8 text without a byte-order mark. */
async function readTimelineText(path) {
	const text = await readFile(path, "utf8");
	return text.startsWith("﻿") ? text.slice(1) : text;
}
/**
* Keep only the clips one render covers.
* @param timeline - The whole episode timeline.
* @param lastShot - The last body shot this render delivers.
* @returns The selected clips, in file order.
* @throws {Error} When the timeline does not hold exactly `lastShot` body clips.
*/
function selectBodyClips(timeline, lastShot) {
	const clips = timeline.clips.filter((clip) => clip.shot <= lastShot);
	if (clips.length !== lastShot) throw new Error(`时间线里 shot <= ${String(lastShot)} 的镜头有 ${String(clips.length)} 个，应为 ${String(lastShot)} 个。请把 lastShot 改成时间线的最后一个镜头号（${String(timeline.clips.length)}），或先用 prepare 补齐缺失的镜头。`);
	return clips;
}
/**
* Lay clips out on one continuous clock from their own durations.
* @param durations - One duration in microseconds per shot, in shot order.
* @returns The timeline with `start_us` accumulated from zero.
*/
function appendClips(durations) {
	const clips = [];
	let cursor = 0;
	for (const [index, durationUs] of durations.entries()) {
		clips.push({
			shot: index + 1,
			startUs: cursor,
			durationUs
		});
		cursor += durationUs;
	}
	return {
		clips,
		bodyEndSeconds: bodyEndSecondsOf(clips)
	};
}
/**
* Render one timeline as the JSON text `prepare` writes.
* @param timeline - The timeline to serialize.
* @returns Pretty-printed JSON with a trailing newline.
*/
function formatTimelineDocument(timeline) {
	return `${JSON.stringify({
		clips: timeline.clips.map((clip) => ({
			shot: clip.shot,
			start_us: clip.startUs,
			duration_us: clip.durationUs
		})),
		body_end: timeline.bodyEndSeconds
	}, null, 2)}\n`;
}
//#endregion
//#region lib/types/prepare.js
/**
* `prepare`: build the directory layout a render consumes, without encoding any
* picture.
*
* The renderer reads one finished video per shot, one episode master, one
* timeline, and one subtitle. This method produces exactly those four from a
* shot-sources manifest: each source video is copied into
* `video/<集>/shot_00N.mp4`, the timeline is laid out from the *probed* durations
* rather than declared ones, the master is assembled by placing each shot's own
* sound at its own start with no gain and no per-shot resampling, and the
* subtitle is installed at the path the renderer burns from.
*
* @module @deepseek-ai/dsh-tool-episode-render/prepare
*/
/** Microseconds in one second. */
const MICROSECONDS_PER_SECOND$1 = 1e6;
/** Resolve one manifest path against the project root. */
function resolveAgainst(project, path) {
	return isAbsolute(path) ? path : resolve(project, path);
}
/**
* Read and validate one shot-sources manifest.
* @param document - The parsed JSON value.
* @param path - The manifest path, for diagnostics.
* @returns One row per shot, ordered by shot number.
* @throws {Error} When `shots` is missing, a row is malformed, or shot numbers are not 1..N without gaps.
*/
function parseShotManifest(document, path) {
	if (typeof document !== "object" || document === null || !Array.isArray(document.shots)) throw new Error(`${path}: 成片清单必须是 {"shots":[{"shot":1,"video":"media/02/p1-clean.mp4"}]}。请把每镜的成片路径写进 shots 数组后重试。`);
	const rows = document.shots.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) throw new Error(`${path}：第 ${String(index + 1)} 行不是对象。请提供 {"shot":N,"video":"<成片路径>","audio":"<可选音轨路径>"} 形式的行。`);
		const row = entry;
		if (row.package !== void 0 && (!Number.isInteger(row.package) || row.package < 1)) throw new Error(`${path}：package 必须是 video_tasks 中从 1 开始的整数包号，不得从镜头号猜测。`);
		if (!Number.isInteger(row.shot) || row.shot < 1) throw new Error(`${path}：第 ${String(index + 1)} 行的 shot 必须是正整数镜头号，收到 ${JSON.stringify(row.shot)}。`);
		if (typeof row.video !== "string" || row.video.trim() === "") throw new Error(`${path}：镜头 ${String(row.shot)} 缺少 video。请填该镜成片文件的路径（通常是 media/<集>/pN-clean.mp4）。`);
		if (row.audio !== void 0 && (typeof row.audio !== "string" || row.audio.trim() === "")) throw new Error(`${path}：镜头 ${String(row.shot)} 的 audio 不是非空字符串。请填该镜音轨文件的路径，或整行省略 audio 以使用成片自带的音轨。`);
		return {
			shot: row.shot,
			...row.package === void 0 ? {} : { package: row.package },
			video: row.video,
			audio: typeof row.audio === "string" ? row.audio : row.video
		};
	});
	if (rows.length === 0) throw new Error(`${path}: 成片清单没有任何镜头，无法构建渲染输入。请至少写入一镜。`);
	const numbers = rows.map((row) => row.shot).sort((left, right) => left - right);
	if (numbers.some((shot, index) => shot !== index + 1)) throw new Error(`${path}: 镜头号必须是 1..${String(rows.length)} 连续无重复，收到 [${numbers.join(", ")}]。请补上缺失的镜头或改正镜头号后重试。`);
	return [...rows].sort((left, right) => left.shot - right.shot);
}
/**
* Probe every shot's source and pair it with the sound that carries its audio.
* @param toolkit - The binaries and channel to use.
* @param project - Absolute project root.
* @param rows - The manifest rows, in shot order.
* @returns One resolved shot per row.
* @throws {Error} When a source cannot be probed, has no video stream, has no audio and none was declared, or reports no duration.
*/
async function resolveShots(toolkit, project, rows) {
	const resolved = [];
	for (const row of rows) {
		const video = resolveAgainst(project, row.video);
		const declaredAudio = resolveAgainst(project, row.audio);
		let media;
		try {
			media = await probeMedia(toolkit, video);
		} catch (error) {
			throw new Error(`镜头 ${String(row.shot)} 的成片无法探测：${video}。请确认该文件存在且可解码（通常是 media/<集>/pN-clean.mp4），修正清单后重试。`, { cause: error });
		}
		if (firstStreamOfType(media, "video") === void 0) throw new Error(`镜头 ${String(row.shot)} 的成片没有视频流：${video}。请把 video 指向该镜真正的成片文件后重试。`);
		const hasOwnAudio = firstStreamOfType(media, "audio") !== void 0;
		const audio = declaredAudio === video && !hasOwnAudio ? void 0 : declaredAudio;
		if (audio === void 0) throw new Error(`镜头 ${String(row.shot)} 的成片没有音轨：${video}。请在清单里为该镜显式指定 audio（例如该镜自己的 provider 视频），否则整集原声会缺这一段。`);
		const durationUs = Math.round(media.durationSeconds * MICROSECONDS_PER_SECOND$1);
		if (durationUs <= 0) throw new Error(`镜头 ${String(row.shot)} 的成片时长为 0：${video}。请重新导出该镜的成片；空文件不能进入渲染。`);
		resolved.push({
			source: row,
			video,
			audio,
			durationUs
		});
	}
	return resolved;
}
/**
* Build the filter graph that lays every shot's own sound on the picture clock.
*
* Nothing is resampled per shot, no gain is applied, and no silence is inserted:
* each input is trimmed to its own shot length, its timestamps are reset, and it
* is delayed to the shot's start. The single 48 kHz conversion happens once, when
* the mixed result is written.
* @param clips - The clips, in shot order.
* @returns The filter graph, whose only output pad is `[a]`.
*/
function masterAudioFilter(clips) {
	const parts = clips.map((clip, index) => {
		const seconds = (clip.durationUs / MICROSECONDS_PER_SECOND$1).toFixed(6);
		const delayMs = Math.round(clip.startUs / 1e3);
		return `[${String(index)}:a]atrim=0:${seconds},asetpts=N/SR/TB,adelay=delays=${String(delayMs)}:all=1[a${String(index)}]`;
	});
	const labels = clips.map((_, index) => `[a${String(index)}]`).join("");
	return `${parts.join(";")};${labels}amix=inputs=${String(clips.length)}:duration=longest:normalize=0[a]`;
}
/**
* Warn when a cue would be burned past the end of the assembled picture.
* @param cues - The installed subtitles.
* @param bodyEndSeconds - Where the assembled picture ends.
* @returns One warning per cue that runs past the end, in cue order.
*/
function cueOverrunWarnings(cues, bodyEndSeconds) {
	return cues.filter((cue) => cue.endSeconds > bodyEndSeconds).map((cue) => `字幕第 ${String(cue.index)} 条结束于 ${cue.endSeconds.toFixed(3)}s，超过整集画面时长 ${bodyEndSeconds.toFixed(3)}s，烧录后会被截断。请把该条字幕的时间收到 body_end 以内后重跑 prepare。`);
}
/**
* Read one JSON document.
* @param path - Absolute path of the file.
* @param description - What the document is, named in the diagnostic.
* @returns The parsed value.
* @throws {Error} When the file cannot be read or is not valid JSON.
*/
async function readJsonDocument(path, description) {
	const text = await readFile(path, "utf8");
	try {
		return JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
	} catch (error) {
		throw new Error(`${path}: ${description}不是合法 JSON。请确认它是 UTF-8 的 JSON 文件。`, { cause: error });
	}
}
/** Build the episode master by mixing every shot's own sound onto the picture clock. */
async function buildMaster(toolkit, shots, clips, target) {
	const args = [
		"-y",
		"-v",
		"error"
	];
	for (const shot of shots) args.push("-i", shot.audio);
	args.push("-filter_complex", masterAudioFilter(clips), "-map", "[a]", "-c:a", "pcm_s16le", "-ar", "48000", target);
	await runFfmpeg(toolkit, args);
}
/**
* Lay out one episode's render inputs.
* @param input - The resolved call.
* @returns The shots, the timeline, the installed cues, every path written, and the non-blocking warnings.
* @throws {Error} When the manifest, a source video, the master build, or the subtitle is unusable.
*/
async function prepareEpisode(input) {
	const paths = episodePaths(input.project, input.episode);
	const rows = parseShotManifest(await readJsonDocument(input.shotsPath, "成片清单"), input.shotsPath);
	await assertVideosAllowed(input.project, rows.flatMap((row) => [resolveAgainst(input.project, row.video), resolveAgainst(input.project, row.audio)]));
	const shots = await resolveShots(input.toolkit, input.project, rows);
	const timeline = appendClips(shots.map((shot) => shot.durationUs));
	const packagePath = resolve(input.project, "episode_packages", input.episode, "package.json");
	const packageHash = rows.some((row) => row.package !== void 0) && await pathExists(packagePath) ? await fileSha256(packagePath) : void 0;
	await assertVideosAllowed(input.project, shots.flatMap((shot) => [shot.video, shot.audio]));
	const written = [];
	await rm(paths.sources, { force: true });
	const selected = [];
	await mkdir(paths.videoDir, { recursive: true });
	for (const shot of shots) {
		const target = resolve(paths.videoDir, shotFileName(shot.source.shot));
		await copyFile(shot.video, target);
		const sha256 = await fileSha256(target);
		await assertVideoHashesAllowed(input.project, [sha256]);
		written.push(target);
		selected.push({
			...shot.source,
			video: shot.video,
			audio: shot.audio,
			sha256,
			...shot.source.package === void 0 || packageHash === void 0 ? {} : { package_sha256: packageHash }
		});
	}
	await mkdir(resolve(input.project, "editing"), { recursive: true });
	await writeFile(paths.timeline, formatTimelineDocument(timeline), "utf8");
	written.push(paths.timeline);
	await mkdir(resolve(input.project, "audio"), { recursive: true });
	await buildMaster(input.toolkit, shots, timeline.clips, paths.masterAudio);
	written.push(paths.masterAudio);
	const cues = await readSubtitleCues(input.subtitleSrt);
	await copyFile(input.subtitleSrt, paths.subtitle);
	written.push(paths.subtitle);
	await assertVideoHashesAllowed(input.project, selected.map((shot) => shot.sha256));
	await writeFile(paths.sources, `${JSON.stringify({ shots: selected }, null, 2)}\n`, "utf8");
	written.push(paths.sources);
	return {
		shots,
		timeline,
		cues,
		written,
		warnings: cueOverrunWarnings(cues, timeline.bodyEndSeconds)
	};
}
//#endregion
//#region lib/types/speech.js
/**
* Subtitle timing taken from a recognition alignment.
*
* The lines are already known — the shot script declares them — and their times
* come from a recognizer that ran over the same clips. Nothing here recognizes
* speech or measures energy: a level cannot say which words fall where, and an
* estimated split inside a stretch is what puts a subtitle on the wrong line.
* The document says when each line is spoken; this module keeps the script's
* text, orders the cues on the episode clock, and reports what does not fit.
*
* A document whose text disagrees with the script describes a different take,
* which is a defect rather than a number to trust.
*
* @module @deepseek-ai/dsh-tool-episode-render/speech
*/
/** Shortest cue written to the delivery. */
const MIN_CUE_SECONDS = .8;
/**
* Count the characters that are actually spoken: CJK, Latin letters, and digits.
* @param text - The line to weigh, punctuation and spaces excluded.
* @returns The number of counted characters.
*/
function effectiveCharacterCount(text) {
	return (text.match(/[\u4e00-\u9fffA-Za-z0-9]/g) ?? []).length;
}
/** Remove the whitespace a recognizer and a script disagree about. */
function withoutSpace(text) {
	return text.replace(/\s+/gu, "");
}
/** The millisecond the SRT writer keeps, so a placed time carries no floating-point noise. */
function toMilliseconds(seconds) {
	return Math.round(seconds * 1e3) / 1e3;
}
/**
* Place one shot's lines on times an outside alignment already measured.
*
* The alignment proves where each line is spoken; it never supplies the words.
* @param shot - Shot number.
* @param lines - The shot's lines, in spoken order.
* @param aligned - The recognized stretches for this shot, in time order.
* @param clipStartSeconds - Where this shot starts on the episode clock.
* @param clipDurationSeconds - This shot's probed duration.
* @returns The placed cues, or the defect that makes the alignment unusable.
*/
function placeAlignedCues(shot, lines, aligned, clipStartSeconds, clipDurationSeconds) {
	const spoken = lines.map((line) => line.trim()).filter((line) => line !== "");
	const empty = {
		shot,
		cues: [],
		aligned: 0,
		defect: ""
	};
	if (spoken.length === 0) return empty;
	if (aligned.length !== spoken.length) return {
		...empty,
		defect: `镜头 ${String(shot)} 的对齐文档有 ${String(aligned.length)} 段，但台词计划声明 ${String(spoken.length)} 条：这份对齐不是为当前台词做的，请用同一版台词重新生成对齐。`
	};
	const clipEnd = clipStartSeconds + clipDurationSeconds;
	const clamp = (value) => toMilliseconds(Math.min(Math.max(value, clipStartSeconds), clipEnd));
	const cues = [];
	let clock = clipStartSeconds;
	for (const [index, text] of spoken.entries()) {
		const stretch = aligned[index];
		if (withoutSpace(stretch.text) !== withoutSpace(text)) return {
			...empty,
			defect: `镜头 ${String(shot)} 第 ${String(index + 1)} 条对齐文本“${stretch.text}”与台词的“${text}”不一致：对齐文档对应的不是这一版台词。字幕文字只取剧本原文，请重新生成对齐后再提交。`
		};
		if (!Number.isFinite(stretch.startSeconds) || !Number.isFinite(stretch.endSeconds) || stretch.endSeconds <= stretch.startSeconds) return {
			...empty,
			defect: `镜头 ${String(shot)} 第 ${String(index + 1)} 条对齐时间无效（${String(stretch.startSeconds)}–${String(stretch.endSeconds)}）：请检查生成对齐的脚本输出。`
		};
		const start = clamp(Math.max(clipStartSeconds + stretch.startSeconds, clock));
		const end = clamp(Math.max(clipStartSeconds + stretch.endSeconds, start + MIN_CUE_SECONDS));
		cues.push({
			shot,
			text,
			startSeconds: start,
			endSeconds: end,
			timingSource: "asr_aligned"
		});
		clock = end;
	}
	return {
		shot,
		cues,
		aligned: cues.length,
		defect: ""
	};
}
/**
* Read one episode's line plan.
* @param document - The parsed JSON value.
* @param path - The plan path, for diagnostics.
* @returns One entry per shot, ordered by shot number.
* @throws {Error} When the plan is not `{"shots":[{"shot":N,"lines":["..."]}]}` or repeats a shot number.
*/
function parseLinePlan(document, path) {
	if (typeof document !== "object" || document === null || !Array.isArray(document.shots)) throw new Error(`${path}: 台词计划必须是 {"shots":[{"shot":1,"lines":["第一句","第二句"]}]}。请把每镜已切好的台词写进 shots 数组后重试。`);
	const rows = document.shots.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) throw new Error(`${path}：第 ${String(index + 1)} 行不是对象。请提供 {"shot":N,"lines":["..."]} 形式的行。`);
		const row = entry;
		if (!Number.isInteger(row.shot) || row.shot < 1) throw new Error(`${path}：第 ${String(index + 1)} 行的 shot 必须是正整数镜头号。`);
		if (!Array.isArray(row.lines) || row.lines.some((line) => typeof line !== "string")) throw new Error(`${path}：镜头 ${String(row.shot)} 的 lines 必须是字符串数组，每项一条字幕。`);
		return {
			shot: row.shot,
			lines: row.lines
		};
	});
	const shots = rows.map((row) => row.shot);
	if (new Set(shots).size !== shots.length) throw new Error(`${path}：镜头号重复。请让每个镜头在计划里只出现一次。`);
	return [...rows].sort((left, right) => left.shot - right.shot);
}
/**
* Read one episode's alignment document.
*
* The document is per shot and clip-relative, which is how a recognizer running
* over one shot's own clip reports it: `{"shots":[{"shot":1,"cues":[{"text":
* "陆沉舟","start":0.0,"end":0.85}]}]}`. Its text is matched against the script
* and never written to a subtitle.
* @param document - The parsed JSON value.
* @param path - The document path, for diagnostics.
* @returns One entry per shot, ordered by shot number.
* @throws {Error} When the document does not carry a `shots` array of timed cues.
*/
function parseAlignment(document, path) {
	if (typeof document !== "object" || document === null || !Array.isArray(document.shots)) throw new Error(`${path}: 对齐文档必须是 {"shots":[{"shot":1,"cues":[{"text":"…","start":0.0,"end":0.8}]}]}。`);
	const rows = document.shots.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) throw new Error(`${path}：第 ${String(index + 1)} 行不是对象。`);
		const row = entry;
		if (!Number.isInteger(row.shot) || row.shot < 1) throw new Error(`${path}：第 ${String(index + 1)} 行的 shot 必须是正整数镜头号。`);
		if (!Array.isArray(row.cues)) throw new Error(`${path}：镜头 ${String(row.shot)} 的 cues 必须是数组。`);
		const cues = row.cues.map((raw, position) => {
			const cue = typeof raw === "object" && raw !== null ? raw : {};
			const start = Number(cue.start);
			const end = Number(cue.end);
			if (typeof cue.text !== "string" || !Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`${path}：镜头 ${String(row.shot)} 第 ${String(position + 1)} 条 cue 必须含 text、start、end。`);
			return {
				text: cue.text,
				startSeconds: start,
				endSeconds: end
			};
		});
		const strategy = row.strategy;
		if (strategy !== void 0 && typeof strategy !== "string") throw new Error(`${path}：镜头 ${String(row.shot)} 的 strategy 必须是字符串。标签类型不对时不能当成「没有标签」放行，请检查生成对齐的脚本输出。`);
		return {
			shot: row.shot,
			cues,
			...strategy === void 0 ? {} : { strategy }
		};
	});
	const shots = rows.map((row) => row.shot);
	if (new Set(shots).size !== shots.length) throw new Error(`${path}：镜头号重复。请让每个镜头在对齐文档里只出现一次。`);
	return [...rows].sort((left, right) => left.shot - right.shot);
}
/**
* Report every cue whose reading speed is too high.
* @param cues - Placed cues on the episode clock.
* @param clipStarts - Where each shot starts on the episode clock, keyed by shot number.
* @returns One finding per cue past {@link FAST_CHARACTER_RATE}, worst first.
*/
function cueRateFindings(cues, clipStarts) {
	const findings = [];
	for (const cue of cues) {
		const clipEnd = clipStarts.get(cue.shot);
		const seconds = cue.endSeconds - cue.startSeconds;
		if (clipEnd === void 0 || seconds <= 0) continue;
		const rate = effectiveCharacterCount(cue.text) / seconds;
		if (rate > 12) findings.push({
			shot: cue.shot,
			text: cue.text,
			charactersPerSecond: rate,
			impossible: rate > 20
		});
	}
	return findings.sort((left, right) => right.charactersPerSecond - left.charactersPerSecond);
}
//#endregion
//#region lib/types/cues.js
/**
* Build one episode's subtitle from a recognition alignment.
*
* `prepare` consumes an SRT and `render` burns it; this module is the step that
* produces that SRT. The line plan says what each shot says and the alignment
* document says when — the two are checked against each other, and only then do
* the cues land on the episode clock. The words in a cue are always the script's.
*
* A shot whose alignment speaks while the plan declares no line for it is
* reported rather than silently dropped, because that is how a delivery loses a
* line, and a declared line the alignment does not cover blocks the same way.
*
* @module @deepseek-ai/dsh-tool-episode-render/cues
*/
/** The tolerance both the timeline check and the subtitle writer use. */
const TIMELINE_TOLERANCE_SECONDS = .05;
/**
* Judge the placed cues against the episode's own timeline.
* @param cues - The placed cues on the episode clock.
* @param bodyEndSeconds - The measured end of the episode body.
* @returns One defect per cue that is empty, overlaps its predecessor, or runs past the body.
*/
function timelineDefects(cues, bodyEndSeconds) {
	const defects = [];
	let previousEnd = -Infinity;
	for (const cue of cues) {
		const fix = "请复核该镜的成片与台词计划，并用同一版台词重新生成对齐；不要手工改 SRT。";
		if (cue.endSeconds - cue.startSeconds <= 0) {
			defects.push({
				id: "subtitle_timing",
				detail: `镜头 ${String(cue.shot)} 的“${cue.text}”时长不是正数（${cue.startSeconds.toFixed(3)}s–${cue.endSeconds.toFixed(3)}s）。`,
				fix
			});
			continue;
		}
		if (cue.startSeconds < previousEnd - TIMELINE_TOLERANCE_SECONDS) defects.push({
			id: "subtitle_timing",
			detail: `镜头 ${String(cue.shot)} 的“${cue.text}”起点 ${cue.startSeconds.toFixed(3)}s 早于上一条字幕的结束 ${previousEnd.toFixed(3)}s：两条字幕会重叠。`,
			fix
		});
		if (cue.endSeconds > bodyEndSeconds + TIMELINE_TOLERANCE_SECONDS) defects.push({
			id: "subtitle_timing",
			detail: `镜头 ${String(cue.shot)} 的“${cue.text}”结束 ${cue.endSeconds.toFixed(3)}s 超出正文末尾 ${bodyEndSeconds.toFixed(3)}s。`,
			fix
		});
		previousEnd = Math.max(previousEnd, cue.endSeconds);
	}
	return defects;
}
/**
* Place every shot's declared lines on the episode clock and write the SRT.
*
* The plan is read rather than composed: a line's text and its split into cues
* are the shot script's decisions, and the alignment only says when they happen.
* @param input - The resolved call.
* @returns The timeline, the per-shot placements, the written cues, and the reported defects.
* @throws {Error} When the manifest, the plan, or the alignment document is unusable.
*/
async function buildEpisodeCues(input) {
	const rows = parseShotManifest(await readJsonDocument(input.shotsPath, "成片清单"), input.shotsPath);
	const plan = parseLinePlan(await readJsonDocument(input.linesPath, "台词计划"), input.linesPath);
	const aligned = new Map(parseAlignment(await readJsonDocument(input.alignmentPath, "对齐文档"), input.alignmentPath).map((row) => [row.shot, row]));
	const shots = await resolveShots(input.toolkit, input.project, rows);
	const timeline = appendClips(shots.map((shot) => shot.durationUs));
	const planned = new Map(plan.map((row) => [row.shot, row.lines]));
	const placements = [];
	const failures = [];
	const warnings = [];
	for (const [index, shot] of shots.entries()) {
		const clip = timeline.clips[index];
		const durationSeconds = shot.durationUs / 1e6;
		const startSeconds = clip === void 0 ? 0 : clip.startUs / 1e6;
		const lines = planned.get(shot.source.shot) ?? [];
		const recognized = aligned.get(shot.source.shot);
		if (lines.length === 0) {
			if ((recognized?.cues ?? []).length === 0) continue;
			failures.push({
				id: "subtitle_line_coverage",
				detail: `镜头 ${String(shot.source.shot)} 的对齐文档里有 ${String(recognized?.cues.length ?? 0)} 段识别结果，但台词计划里没有它的台词，这一镜说的话会变成没有字幕的语音。`,
				fix: `把该镜的台词补进 ${input.linesPath}，或确认这一镜本就不该有台词。`
			});
			continue;
		}
		if (recognized === void 0) {
			failures.push({
				id: "subtitle_line_coverage",
				detail: `镜头 ${String(shot.source.shot)} 声明了 ${String(lines.length)} 条台词，但对齐文档里没有这一镜的时间。`,
				fix: `对 ${shot.video} 重跑一次语音识别，把这一镜的结果补进 ${input.alignmentPath}；不要用估算时间给这一镜排字幕。`
			});
			continue;
		}
		if (recognized.strategy !== "asr_aligned") {
			failures.push({
				id: "subtitle_line_coverage",
				detail: `镜头 ${String(shot.source.shot)} 的对齐来源未验证：${recognized.strategy === void 0 ? "文档没有标 strategy" : `标着 ${recognized.strategy}`}，不是 align_subtitles.py 写出的整镜锚定结果。`,
				fix: "用 align_subtitles.py 对该镜重跑识别，并把整份对齐文档换成它写出的那一份；只有 asr_aligned 的镜头才允许生成正式字幕。"
			});
			continue;
		}
		const placement = placeAlignedCues(shot.source.shot, lines, recognized.cues, startSeconds, durationSeconds);
		placements.push(placement);
		if (placement.defect !== "") failures.push({
			id: "subtitle_line_coverage",
			detail: placement.defect,
			fix: "复核该镜成片是否真的读了这句台词；确认后重跑识别，让对齐与台词计划指向同一版台词。"
		});
	}
	const unknown = plan.filter((row) => !shots.some((shot) => shot.source.shot === row.shot)).map((row) => row.shot);
	if (unknown.length > 0) failures.push({
		id: "subtitle_line_coverage",
		detail: `台词计划里的镜头 ${unknown.join("、")} 不在成片清单里。`,
		fix: "请确认镜头号写对，或把这些镜头补进成片清单后重跑。"
	});
	const unknownAligned = [...aligned.keys()].filter((shot) => !shots.some((row) => row.source.shot === shot));
	if (unknownAligned.length > 0) warnings.push(`对齐文档里的镜头 ${unknownAligned.join("、")} 不在成片清单里，已忽略。`);
	const placed = placements.flatMap((placement) => placement.cues);
	const findings = cueRateFindings(placed, new Map(shots.map((shot, index) => {
		const clip = timeline.clips[index];
		return [shot.source.shot, clip === void 0 ? 0 : clip.startUs / 1e6];
	})));
	for (const finding of findings) {
		const detail = `镜头 ${String(finding.shot)} 的“${finding.text}”要求 ${finding.charactersPerSecond.toFixed(1)} 字/秒（${String(effectiveCharacterCount(finding.text))} 字），`;
		if (finding.impossible) failures.push({
			id: "subtitle_timing",
			detail: `${detail}超过可读上限，观众来不及看。`,
			fix: "请复核该镜时长与台词切分：把这条台词拆到更多镜头，或延长该镜后重做。"
		});
		else warnings.push(`${detail}偏快，请试听复核。`);
	}
	failures.push(...timelineDefects(placed, timeline.bodyEndSeconds));
	const cues = placed.map((cue, index) => ({
		index: index + 1,
		startSeconds: cue.startSeconds,
		endSeconds: cue.endSeconds,
		text: cue.text
	}));
	await mkdir(dirname(input.subtitleSrt), { recursive: true });
	await writeFile(input.subtitleSrt, formatSrtDocument(cues), "utf8");
	return {
		shots,
		timeline,
		placements,
		cues,
		written: [input.subtitleSrt],
		failures,
		warnings
	};
}
//#endregion
//#region lib/types/report.js
/**
* Builder from the renderer's internal result to the model-facing one.
*
* The result keeps the pipeline's own snake_case spellings, because it is read
* next to `body_end`, `body_end_seconds`, and the delivery specification it
* reports on. Every field is always present: a method that did not measure
* something reports the empty value, so a caller never has to branch on which
* keys exist.
*
* @module @deepseek-ai/dsh-tool-episode-render/report
*/
/** The tail-frame record for a method that built no ending. */
const NO_TAIL_FRAME = {
	path: "",
	frameMd5: "",
	sequentialTailMd5: "",
	fromSequentialDecode: false,
	matchesSequentialTail: false
};
/** The measured-facts record for a method that measured no delivered file. */
const NO_MEDIA = {
	durationSeconds: 0,
	sizeBytes: 0,
	bitrateBps: 0,
	videoCodec: "",
	width: 0,
	height: 0,
	fps: 0,
	hasAudio: false,
	audioCodec: "",
	audioSampleRate: 0
};
/** Map one extracted tail frame to the shape the model reads. */
function tailFrameReport(evidence) {
	return {
		path: evidence.path,
		frame_md5: evidence.frameMd5,
		sequential_tail_md5: evidence.sequentialTailMd5,
		from_sequential_decode: evidence.fromSequentialDecode,
		matches_sequential_tail: evidence.matchesSequentialTail
	};
}
/** Map one measured media record to the shape the model reads. */
function mediaReport(media) {
	return {
		duration_seconds: media.durationSeconds,
		size_bytes: media.sizeBytes,
		bitrate_bps: media.bitrateBps,
		video_codec: media.videoCodec,
		width: media.width,
		height: media.height,
		fps: media.fps,
		has_audio: media.hasAudio,
		audio_codec: media.audioCodec,
		audio_sample_rate: media.audioSampleRate
	};
}
/**
* Build the canonical result of one `drama_render` call.
*
* `ok` is true exactly when no failure-severity check failed; warnings ride along
* without changing it.
* @param input - Operation identity, timeline, resolved sources, and every measured fact.
* @returns The result the tool returns and renders.
*/
function buildReport(input) {
	const failures = input.checks.filter((check) => check.severity === "failure" && !check.ok).map((check) => `${check.id}: ${check.detail} 修法：${check.fix}`);
	const warnings = [...input.warnings, ...input.checks.filter((check) => check.severity === "warning" && !check.ok).map((check) => `${check.id}: ${check.detail} 修法：${check.fix}`)];
	const clips = input.timeline.clips.map((clip) => ({
		shot: clip.shot,
		source: input.sources.get(clip.shot) ?? "",
		start_us: clip.startUs,
		duration_us: clip.durationUs
	}));
	const summary = {
		shots: clips.length,
		encoded: input.encodedShots.length,
		reused: input.reusedShots.length,
		checks: input.checks.length,
		failed_checks: input.checks.filter((check) => !check.ok).length,
		warnings: warnings.length
	};
	return {
		method: input.method,
		ok: failures.length === 0,
		project: input.project,
		episode: input.episode,
		clips,
		body_end_seconds: input.timeline.bodyEndSeconds,
		expected_duration_seconds: input.expectedDurationSeconds,
		written: [...input.written],
		output: input.output,
		encoder: input.encoder,
		gpu_requested: input.gpuRequested,
		gpu_used: input.gpuUsed,
		encoder_fallback_reason: input.encoderFallbackReason,
		encoded_shots: [...input.encodedShots],
		reused_shots: [...input.reusedShots],
		tail_frame: tailFrameReport(input.tailFrame),
		media: mediaReport(input.media),
		checks: [...input.checks],
		not_checked: [
			"duration",
			"video_stream",
			"frame_rate",
			"audio_stream",
			"bitrate_floor",
			"black_frames",
			"silence",
			"subtitle_bounds",
			"subtitle_present",
			"speech_alignment",
			"embedded_subtitles",
			"content_review",
			"bgm_listening",
			"bgm_plan_audio_match",
			...input.method === "verify" ? ["output_source_mapping"] : [],
			...input.bgmPlan?.path ? [] : ["bgm_plan"]
		].filter((id) => !input.checks.some((check) => check.id === id)),
		bgm_plan: input.bgmPlan ?? {
			path: "",
			bed_sha256: "",
			segments: [],
			repeated_sequence_episodes: []
		},
		failures,
		warnings,
		log_path: input.logPath,
		summary
	};
}
//#endregion
//#region lib/types/bgm.js
/** Validate the existing episode/segments BGM plan without choosing or mixing music. */
/** Existing plan fields used by the renderer; creative notes remain caller-owned. */
const Plan = z.object({ episodes: z.array(z.object({
	episode: z.string().required(),
	body_duration_seconds: z.number().required(),
	segments: z.array(z.object({
		track: z.string().required(),
		source: z.string().required(),
		start_seconds: z.number().required(),
		end_seconds: z.number().required(),
		reason: z.string().default("")
	})).required()
})).required() });
/**
* Read one plan and return its declared segments and repeat advice.
* @param path - Optional existing BGM plan path.
* @param episode - Two-digit episode number.
* @param bodyEnd - Actual timeline body end, in seconds.
* @param bed - The single mixed bed supplied to render.
* @param project - Base for relative track source identities.
* @returns Declared plan evidence; no claim about the sound's contents.
* @throws {Error} When a supplied plan is malformed, ambiguous, or disagrees with the timeline.
*/
async function readBgmPlan(path, episode, bodyEnd, bed, project) {
	if (path === void 0) return {
		path: "",
		bed_sha256: "",
		segments: [],
		repeated_sequence_episodes: []
	};
	let plan;
	try {
		plan = Plan(JSON.parse((await readFile(path, "utf8")).replace(/^\ufeff/, "")));
	} catch (error) {
		throw new Error(`BGM 计划不可读：${path}`, { cause: error });
	}
	const ids = plan.episodes.map((row) => row.episode.padStart(2, "0"));
	if (new Set(ids).size !== ids.length || ids.some((id) => !/^\d+$/.test(id))) throw new Error("BGM 计划集号重复或无效。");
	const selected = plan.episodes.find((row) => row.episode.padStart(2, "0") === episode);
	if (selected === void 0) throw new Error(`BGM 计划缺少第 ${episode} 集。`);
	if (!Number.isFinite(selected.body_duration_seconds) || Math.abs(selected.body_duration_seconds - bodyEnd) > .001) throw new Error("BGM 计划正文时长与当前时间线不一致。");
	let previousStart = 0;
	for (const segment of selected.segments) {
		if (!segment.track.trim() || !segment.source.trim() || !Number.isFinite(segment.start_seconds) || !Number.isFinite(segment.end_seconds) || segment.start_seconds < 0 || segment.end_seconds <= segment.start_seconds || segment.start_seconds < previousStart || segment.end_seconds > bodyEnd + .001) throw new Error("BGM 段落须有曲目来源及按起点排序、不越界的正文时间。");
		previousStart = segment.start_seconds;
	}
	if (selected.segments.length === 0) throw new Error("BGM 计划没有段落。");
	const signature = (segments) => JSON.stringify(segments.map((segment) => resolve(project, segment.source)));
	return {
		path,
		bed_sha256: await fileSha256(bed),
		segments: selected.segments.map(({ track, source, start_seconds, end_seconds, reason }) => ({
			track,
			source,
			start_seconds,
			end_seconds,
			reason
		})),
		repeated_sequence_episodes: plan.episodes.filter((row) => row !== selected && signature(row.segments) === signature(selected.segments)).map((row) => row.episode.padStart(2, "0"))
	};
}
/**
* The sidecar path for one delivery.
* @param output - Absolute path of the delivered file.
* @returns The sidecar path beside it.
*/
function provenancePathFor(output) {
	return `${output}.provenance.json`;
}
/**
* Build one delivery's record.
* @param input - The delivered file's facts, the digests consumed, and the verdicts run.
* @returns The record, ready to write.
*/
function buildProvenance(input) {
	return {
		version: 1,
		episode: input.episode,
		rendered_at: input.now.toISOString(),
		output: {
			path: input.output,
			sha256: input.outputSha256,
			size_bytes: input.sizeBytes,
			duration_seconds: input.durationSeconds
		},
		inputs: [...input.inputs],
		encoder: input.encoder,
		checks: input.checks.map((check) => ({
			id: check.id,
			ok: check.ok,
			severity: check.severity
		}))
	};
}
/**
* Write one delivery's record, replacing any earlier one atomically.
* @param path - Sidecar path.
* @param value - The record.
*/
async function writeProvenance(path, value) {
	await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 384 });
}
/**
* Read one delivery's record.
* @param path - Sidecar path.
* @returns The record, or undefined when the delivery has none.
* @throws {Error} When the sidecar exists but is not a version 1 record.
*/
async function readProvenance(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} 不是合法 JSON：来源清单损坏，不能当作没有清单。`, { cause: error });
	}
	const document = parsed;
	if (document.version !== 1 || typeof document.output?.sha256 !== "string") throw new Error(`${path} 不是 version ${String(1)} 的来源清单。`);
	return document;
}
//#endregion
//#region lib/types/encoder.js
/**
* Encoder selection: probe the GPU encoder, then fall back to the CPU encoder
* with the reason recorded.
*
* The probe encodes one frame of a 256x256 black source. The size matters —
* several NVIDIA generations reject smaller frames as below NVENC's minimum, so
* a 64x64 probe reports a working card as unusable. An old driver, a missing
* NVENC build, or a busy GPU session all fail the probe the same way, which is
* why the failure is a recorded fallback rather than an error: the delivery must
* still happen, and the operator has to be able to see why it happened on the CPU.
*
* @module @deepseek-ai/dsh-tool-episode-render/encoder
*/
/** The CPU encoder used when no GPU encoder is available. */
const CPU_ENCODER = "libx264";
/** The GPU encoder the renderer prefers. */
const GPU_ENCODER = "h264_nvenc";
/**
* Collapse one command's output into a single line a result and a log can carry.
* @param text - The captured output.
* @returns The trimmed last {@link REASON_CHARS} characters with runs of whitespace collapsed.
*/
function collapseReason(text) {
	return text.replace(/\s+/g, " ").trim().slice(-1e3);
}
/**
* Choose the encoder one render uses.
* @param toolkit - The binaries and channel to use.
* @param preferNvenc - Whether the GPU encoder is probed at all.
* @returns The encoder, its arguments, and the probe failure that forced the CPU encoder.
*/
async function chooseEncoder(toolkit, preferNvenc) {
	if (!preferNvenc) return {
		encoder: CPU_ENCODER,
		args: encoderArguments(CPU_ENCODER),
		fallbackReason: "preferNvenc=false：本次不探测 GPU 编码器，直接用 libx264。"
	};
	const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		ENCODER_PROBE_SOURCE,
		"-frames:v",
		"1",
		"-c:v",
		GPU_ENCODER,
		"-f",
		"null",
		"-"
	]);
	if (outcome.code === 0) return {
		encoder: GPU_ENCODER,
		args: encoderArguments(GPU_ENCODER),
		fallbackReason: ""
	};
	return {
		encoder: CPU_ENCODER,
		args: encoderArguments(CPU_ENCODER),
		fallbackReason: `h264_nvenc 探测失败（退出码 ${String(outcome.code)}）：` + collapseReason(outcome.stderr.trim() === "" ? outcome.stdout : outcome.stderr)
	};
}
//#endregion
//#region lib/types/ending.js
/**
* The two-second ending: the last body shot's real tail frame, and the effect
* blended over it.
*
* The tail frame is extracted by seeking to the end (`-sseof`) and is then
* *proved* against a full sequential decode, because a too-short seek window
* returns exit code 0 without writing any file — a silent failure that produced
* an ending built from the wrong frame. The seek window here is 0.1 seconds, and
* the extracted frame's `framemd5` must equal the last frame of a sequential
* decode; when it does not, the frame is re-extracted by index, and if that still
* does not match, the render stops instead of freezing an unverified frame.
*
* @module @deepseek-ai/dsh-tool-episode-render/ending
*/
/**
* How far before the end the seek starts.
*
* `-sseof -0.05` returns exit code 0 without writing a file on some sources, so
* the window is widened rather than trusted. See the module note.
*/
const TAIL_SEEK_SECONDS = "-0.1";
/** The pixel format both sides of the comparison are hashed in. */
const COMPARISON_PIXEL_FORMAT = "rgb24";
/**
* The last video frame's index in a sequential `framemd5` report.
* @param frameCount - Frames the report listed.
* @returns The 0-based index of the final frame.
*/
function lastFrameIndex(frameCount) {
	return frameCount - 1;
}
/**
* Read the frame hashes from a `framemd5` report.
*
* `framemd5` writes one comma-separated line per frame and one hash-only line per
* stream, so only the per-frame lines are hashes of the picture.
* @param output - Everything `framemd5` wrote to standard output.
* @returns One MD5 per decoded frame, in decode order.
*/
function parseFramemd5(output) {
	const hashes = [];
	for (const line of output.split(/\r?\n/)) {
		const fields = line.split(",");
		if (fields.length < 2 || !/^\s*\d+\s*$/.test(fields.slice(0, 1).join(""))) continue;
		const hash = fields.slice(-1).join("").trim();
		if (hash !== "") hashes.push(hash);
	}
	return hashes;
}
/**
* Hash one image file's single frame.
* @param toolkit - The binaries and channel to use.
* @param file - Absolute path of the image to decode.
* @returns The frame's MD5.
* @throws {Error} When the file holds no decodable frame.
*/
async function frameHash(toolkit, file) {
	const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
		"-v",
		"error",
		"-i",
		file,
		"-pix_fmt",
		COMPARISON_PIXEL_FORMAT,
		"-f",
		"framemd5",
		"-"
	]);
	if (outcome.code !== 0) throw new Error(`无法读取尾帧 ${file} 的 framemd5：${outcome.stderr.trim()}。请确认该 PNG 没有被截断；必要时删掉渲染缓存目录后重跑 render。`);
	const hash = parseFramemd5(outcome.stdout).slice(-1).join("");
	if (hash === "") throw new Error(`${file}: 解不出任何一帧的 framemd5，说明这个尾帧文件是空的或已损坏。请删掉渲染缓存目录后重跑 render。`);
	return hash;
}
/**
* Hash every frame of one video by decoding it from the start.
* @param toolkit - The binaries and channel to use.
* @param file - Absolute path of the video to decode.
* @returns The frame hashes in decode order.
* @throws {Error} When the decode fails or yields no frame.
*/
async function sequentialFrameHashes(toolkit, file) {
	const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
		"-v",
		"error",
		"-i",
		file,
		"-an",
		"-pix_fmt",
		COMPARISON_PIXEL_FORMAT,
		"-f",
		"framemd5",
		"-"
	]);
	if (outcome.code !== 0) throw new Error(`无法顺序解码 ${file} 取尾帧：${outcome.stderr.trim()}。请确认该镜的成片文件可完整解码，修复后重跑 render。`);
	const hashes = parseFramemd5(outcome.stdout);
	if (hashes.length === 0) throw new Error(`${file}: 顺序解码没有得到任何一帧，说明该镜的成片是空的或已损坏。请重新导出该镜后重跑 render。`);
	return hashes;
}
/**
* Extract the ending frame and prove it is the source's real last frame.
* @param toolkit - The binaries and channel to use.
* @param sourceVideo - Absolute path of the last body shot's video.
* @param target - Absolute path of the PNG to write.
* @returns The written frame plus the evidence that it is the tail frame.
* @throws {Error} When the seek writes nothing, or the extracted frame cannot be proved to be the tail.
*/
async function extractTailFrame(toolkit, sourceVideo, target) {
	await runFfmpeg(toolkit, [
		"-y",
		"-v",
		"error",
		"-sseof",
		TAIL_SEEK_SECONDS,
		"-i",
		sourceVideo,
		"-frames:v",
		"1",
		"-f",
		"image2",
		target
	]);
	if (!await pathExists(target)) {
		const hashes = await sequentialFrameHashes(toolkit, sourceVideo);
		const sequentialTailMd5 = hashes.slice(-1).join("");
		await runFfmpeg(toolkit, [
			"-y",
			"-v",
			"error",
			"-i",
			sourceVideo,
			"-vf",
			`select=eq(n\\,${String(lastFrameIndex(hashes.length))})`,
			"-frames:v",
			"1",
			"-f",
			"image2",
			target
		]);
		const decodedMd5 = await frameHash(toolkit, target);
		if (decodedMd5 !== sequentialTailMd5) throw new Error(`尾帧校验不通过：顺序抽出的帧 ${decodedMd5} 与最后一帧 ${sequentialTailMd5} 不一致（源文件 ${sourceVideo}）。请确认该文件在渲染期间没有被改写，然后重跑 render。`);
		return {
			path: target,
			frameMd5: decodedMd5,
			sequentialTailMd5,
			fromSequentialDecode: true,
			matchesSequentialTail: true
		};
	}
	const frameMd5 = await frameHash(toolkit, target);
	const hashes = await sequentialFrameHashes(toolkit, sourceVideo);
	const sequentialTailMd5 = hashes.slice(-1).join("");
	if (frameMd5 === sequentialTailMd5) return {
		path: target,
		frameMd5,
		sequentialTailMd5,
		fromSequentialDecode: false,
		matchesSequentialTail: true
	};
	await runFfmpeg(toolkit, [
		"-y",
		"-v",
		"error",
		"-i",
		sourceVideo,
		"-vf",
		`select=eq(n\\,${String(lastFrameIndex(hashes.length))})`,
		"-frames:v",
		"1",
		"-f",
		"image2",
		target
	]);
	const decodedMd5 = await frameHash(toolkit, target);
	if (decodedMd5 !== sequentialTailMd5) throw new Error(`尾帧校验不通过：按索引抽出的帧 ${decodedMd5} 与顺序解码的最后一帧 ${sequentialTailMd5} 不一致（源文件 ${sourceVideo}）。请确认该文件在渲染期间没有被改写，然后重跑 render。`);
	return {
		path: target,
		frameMd5: decodedMd5,
		sequentialTailMd5,
		fromSequentialDecode: true,
		matchesSequentialTail: true
	};
}
/**
* Build the ending clip from the frozen frame and the ending effect.
*
* The freeze image is a looped input and `-t` cuts the result at exactly
* {@link ENDING_SECONDS}, so the ending's length never depends on the effect's own
* duration.
* @param toolkit - The binaries and channel to use.
* @param tailFrame - Absolute path of the frozen frame.
* @param effect - Absolute path of the ending effect video.
* @param target - Absolute path of the clip to write.
* @param encoder - The encoder the body clips were encoded with.
* @param encoderArgs - That encoder's rate-control arguments.
*/
async function buildEndingClip(toolkit, tailFrame, effect, target, encoder, encoderArgs) {
	await runFfmpeg(toolkit, [
		"-y",
		"-v",
		"error",
		"-loop",
		"1",
		"-i",
		tailFrame,
		"-i",
		effect,
		"-filter_complex",
		endingEffectFilter(),
		"-map",
		"[v]",
		"-t",
		2 .toFixed(3),
		"-an",
		"-c:v",
		encoder,
		...encoderArgs,
		target
	]);
}
//#endregion
//#region lib/types/verify.js
/**
* `verify`: the post-render check, and the delivery verdict `render` shares.
*
* The delivered file is judged on what it actually is — its duration, its
* streams, its overall bitrate, its black stretches, its silent stretches, and
* whether any subtitle cue would be burned outside the picture. `verify` reports
* every check instead of stopping at the first failure, so one call is one
* complete repair list; nothing here writes to the delivered file.
*
* @module @deepseek-ai/dsh-tool-episode-render/verify
*/
/** Seconds a delivered duration may differ from the timeline's own sum. */
const DURATION_TOLERANCE_SECONDS = .15;
/** Seconds a subtitle cue may cross a boundary before it counts as out of bounds. */
const CUE_TOLERANCE_SECONDS = .05;
/** `blackdetect` reports a stretch once it lasts this long. */
const BLACK_DETECT_SECONDS = .1;
/** `blackdetect`'s per-pixel luminance ceiling. */
const BLACK_PIXEL_THRESHOLD = .1;
/** A black stretch at least this long means the delivery has a hole in it. */
const BLACK_FAILURE_SECONDS = 1;
/** A black stretch at least this long is worth reading, but does not block. */
const BLACK_WARNING_SECONDS = .3;
/** Level below which `silencedetect` counts as silence. */
const SILENCE_NOISE = "-50dB";
/** `silencedetect` reports a stretch once it lasts this long. */
const SILENCE_DETECT_SECONDS = 1;
/** A silent stretch at least this long means the delivery lost its sound. */
const SILENCE_FAILURE_SECONDS = 3;
/** A silent stretch at least this long is worth reading, but does not block. */
const SILENCE_WARNING_SECONDS = 1;
/** Build one check, leaving the repair instruction empty exactly when it passed. */
function verdict(id, severity, ok, detail, fix) {
	return {
		id,
		severity,
		ok,
		detail,
		fix: ok ? "" : fix
	};
}
/** Join the numeric fields of a detected segment list into one detail line. */
function describeSegments(segments) {
	if (segments.length === 0) return "未检出";
	return segments.map((segment) => `${segment.startSeconds.toFixed(3)}s 起持续 ${segment.durationSeconds.toFixed(3)}s`).join("；");
}
/** The longest stretch in a detected list. */
function longestSeconds(segments) {
	return segments.reduce((longest, segment) => Math.max(longest, segment.durationSeconds), 0);
}
/**
* Judge the delivered file against the fixed delivery specification.
* @param media - The measured facts.
* @param expectedDurationSeconds - The duration the timeline and the ending require.
* @returns Duration, geometry, frame rate, audio, and bitrate checks.
*/
function deliveryChecks(media, expectedDurationSeconds) {
	const durationDelta = Math.abs(media.durationSeconds - expectedDurationSeconds);
	const geometryOk = media.width === 1440 && media.height === 2560 && media.videoCodec === "h264";
	const fpsOk = Math.abs(media.fps - 60) <= .01;
	const audioOk = media.hasAudio && media.audioCodec === "aac" && media.audioSampleRate === 48e3;
	return [
		verdict("duration", "failure", durationDelta <= DURATION_TOLERANCE_SECONDS, `实测 ${media.durationSeconds.toFixed(6)}s，应为 ${expectedDurationSeconds.toFixed(6)}s，差 ${durationDelta.toFixed(6)}s`, `请检查时间线的 body_end 与片尾长度是否与实际画面一致；若差在 ${String(DURATION_TOLERANCE_SECONDS)}s 以内请先确认没有丢帧，否则重跑 render（加 force=true 清缓存）。`),
		verdict("video_stream", "failure", geometryOk, `实测 ${String(media.width)}x${String(media.height)} ${media.videoCodec}`, `交付规格是 ${String(DELIVERY_WIDTH)}x${String(DELIVERY_HEIGHT)} 的 h264。请确认片段都是按交付样式编码后拼接的，并删掉 exports/.render_cache 后重跑 render。`),
		verdict("frame_rate", "failure", fpsOk, `实测 ${media.fps.toFixed(4)}fps，应为 ${String(60)}fps`, "请确认拼接的每一段都用 fps=60 编码；删掉 exports/.render_cache 后重跑 render。"),
		verdict("audio_stream", "failure", audioOk, `实测 音轨=${media.hasAudio ? `${media.audioCodec} ${String(media.audioSampleRate)}Hz` : "缺失"}`, "交付规格要求 AAC 48kHz 音轨。请确认 audio/<集>.wav 存在且混音步骤成功，然后重跑 render。"),
		verdict("bitrate_floor", "failure", media.bitrateBps >= MIN_BITRATE_BPS, `实测 ${(media.bitrateBps / 1e6).toFixed(3)} Mbps，下限 ${(MIN_BITRATE_BPS / 1e6).toFixed(1)} Mbps`, `总码率低于 ${(MIN_BITRATE_BPS / 1e6).toFixed(1)} Mbps 说明素材或编码参数被降档。请确认源片段本身不是低码率转码件，并重跑 render（必要时加 force=true 重编所有片段）。`)
	];
}
/**
* Read the black stretches out of a `blackdetect` log.
*
* A stretch that is still black when the file ends is logged without an end
* timestamp, so it is closed at the file's own duration.
* @param stderr - Everything ffmpeg wrote to standard error.
* @param totalSeconds - The probed file duration, used to close an open stretch.
* @returns Every detected stretch, in log order.
*/
function parseBlackSegments(stderr, totalSeconds) {
	const segments = [];
	let pendingStart;
	for (const match of stderr.matchAll(/black_start:\s*([\d.]+)(?:\s+black_end:\s*([\d.]+))?(?:\s+black_duration:\s*([\d.]+))?/g)) {
		const start = Number(match[1]);
		const duration = match[3];
		if (duration === void 0) {
			pendingStart = start;
			continue;
		}
		segments.push({
			startSeconds: start,
			durationSeconds: Number(duration)
		});
		pendingStart = void 0;
	}
	if (pendingStart !== void 0) segments.push({
		startSeconds: pendingStart,
		durationSeconds: Math.max(0, totalSeconds - pendingStart)
	});
	return segments;
}
/**
* Read the silent stretches out of a `silencedetect` log.
*
* `silencedetect` writes the start and the end on separate lines and omits the
* end when the file stops while still silent, so an unclosed start is taken to
* the file's own duration.
* @param stderr - Everything ffmpeg wrote to standard error.
* @param totalSeconds - The probed file duration, used to close an open stretch.
* @returns Every detected stretch, in log order.
*/
function parseSilenceSegments(stderr, totalSeconds) {
	const segments = [];
	let pendingStart;
	for (const line of stderr.split(/\r?\n/)) {
		const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
		if (start !== null) {
			pendingStart = Number(start[1]);
			continue;
		}
		const duration = /silence_duration:\s*([\d.]+)/.exec(line);
		if (duration !== null && pendingStart !== void 0) {
			segments.push({
				startSeconds: pendingStart,
				durationSeconds: Number(duration[1])
			});
			pendingStart = void 0;
		}
	}
	if (pendingStart !== void 0) segments.push({
		startSeconds: pendingStart,
		durationSeconds: Math.max(0, totalSeconds - pendingStart)
	});
	return segments;
}
/**
* Detect the delivered file's black stretches.
* @param toolkit - The binaries and channel to use.
* @param file - Absolute path of the delivered file.
* @param totalSeconds - The probed file duration.
* @returns Every detected stretch, in log order.
* @throws {Error} When the detection pass itself fails.
*/
async function detectBlackSegments(toolkit, file, totalSeconds) {
	const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
		"-v",
		"info",
		"-i",
		file,
		"-vf",
		`blackdetect=d=${String(BLACK_DETECT_SECONDS)}:pix_th=${String(BLACK_PIXEL_THRESHOLD)}`,
		"-an",
		"-f",
		"null",
		"-"
	]);
	if (outcome.code !== 0) throw new Error(`黑帧检测失败：${file}（${outcome.stderr.trim()}）。请确认交付文件可完整解码后重跑 verify。`);
	return parseBlackSegments(outcome.stderr, totalSeconds);
}
/**
* Detect the delivered file's silent stretches.
* @param toolkit - The binaries and channel to use.
* @param file - Absolute path of the delivered file.
* @param totalSeconds - The probed file duration.
* @returns Every detected stretch, in log order.
* @throws {Error} When the detection pass itself fails.
*/
async function detectSilenceSegments(toolkit, file, totalSeconds) {
	const outcome = await toolkit.channel.run(toolkit.ffmpeg, [
		"-v",
		"info",
		"-i",
		file,
		"-af",
		`silencedetect=noise=${SILENCE_NOISE}:d=${String(SILENCE_DETECT_SECONDS)}`,
		"-vn",
		"-f",
		"null",
		"-"
	]);
	if (outcome.code !== 0) throw new Error(`静音检测失败：${file}（${outcome.stderr.trim()}）。请确认交付文件可完整解码后重跑 verify。`);
	return parseSilenceSegments(outcome.stderr, totalSeconds);
}
/**
* Judge whether every subtitle cue is burned inside the picture.
* @param cues - The installed subtitles.
* @param bodyEndSeconds - Where the body ends; the ending carries no dialogue.
* @param measuredSeconds - The delivered file's measured duration.
* @returns The bounds check, plus a warning when the subtitle carries no cue at all.
*/
function subtitleChecks(cues, bodyEndSeconds, measuredSeconds) {
	const outside = cues.filter((cue) => cue.startSeconds < 0 || cue.endSeconds < cue.startSeconds || cue.endSeconds > bodyEndSeconds + CUE_TOLERANCE_SECONDS || cue.endSeconds > measuredSeconds + CUE_TOLERANCE_SECONDS);
	const detail = outside.length === 0 ? `${String(cues.length)} 条字幕都在 0–${bodyEndSeconds.toFixed(3)}s 之内` : outside.map((cue) => `第 ${String(cue.index)} 条 ${cue.startSeconds.toFixed(3)}–${cue.endSeconds.toFixed(3)}s`).join("；");
	return [verdict("subtitle_bounds", "failure", outside.length === 0, detail, `字幕必须落在 0–${bodyEndSeconds.toFixed(3)}s（body_end）之内，片尾 2 秒不承载台词。请修正这些 cue 的起止时间后重跑 render。`), verdict("subtitle_present", "warning", cues.length > 0, `实测 ${String(cues.length)} 条字幕`, "字幕文件里没有任何 cue。若这集确实没有台词请忽略；否则请检查 SRT 的时间行与空行格式。")];
}
/** Report exact output bans and current selected-source risks, without certifying historical output sources. */
async function videoBanChecks(input, shots) {
	try {
		const bans = (await readVideoBans(input.project)).filter((row) => row.banned);
		if (bans.length === 0) return [];
		const paths = episodePaths(input.project, input.episode);
		const files = [input.output, ...shots.map((shot) => resolve(paths.videoDir, shotFileName(shot)))];
		const affected = [];
		for (const file of files) {
			if (!await pathExists(file)) continue;
			const hash = await fileSha256(file);
			const ban = bans.find((row) => row.sha256 === hash);
			if (ban !== void 0) affected.push(`${file === input.output ? "输出版本已禁用" : "当前选片含禁用素材，已有输出需复核"}：${file} [${hash}] labels=${ban.labels.join("、")} reason=${ban.reason}`);
		}
		return [verdict("video_bans", "failure", affected.length === 0, affected.length > 0 ? affected.join("；") : "当前可读输出与选片未命中禁用 SHA256；未确认历史输出的原源映射。", "请更换禁用版本后重新准备和渲染，或经用户同意解除禁用；解除禁用不代表审核通过。已有文件未删除。")];
	} catch (error) {
		return [verdict("video_bans", "failure", false, String(error), "请修复禁用清单或文件读取问题后重新检查；已有文件未删除。")];
	}
}
/**
* Check the delivery against the record of what was rendered and checked.
*
* The point is that a review belongs to the bytes it was run on. A file replaced at
* the same path still passes every technical check here, so without this comparison
* an older verdict would silently stand in for a file nobody looked at.
* @param input - The resolved verify call.
* @returns The provenance verdict for this delivery.
* @throws {Error} When the sidecar exists but cannot be read as a record.
*/
async function provenanceCheck(input) {
	const path = provenancePathFor(input.output);
	const recorded = await readProvenance(path);
	if (recorded === void 0) return verdict("output_provenance", "warning", false, `这份成片没有来源清单（${path} 不存在）`, "无法证明当前文件就是当初检查过的那个。请重跑 render（它会写出清单），再对此文件跑 verify；在那之前不要把这份成片的检查结论当作对当前文件生效。");
	const current = await fileSha256(input.output);
	return verdict("output_provenance", "failure", current === recorded.output.sha256, `清单记录 ${recorded.rendered_at} 渲染的 sha256=${recorded.output.sha256.slice(0, 16)}…，当前文件 sha256=${current.slice(0, 16)}…`, "成片字节与来源清单不符：同一路径上的文件已经被换过，清单里那些检查与审核不再对应当前文件。请对当前文件重新跑 render 与审核，不要用旧结论交付。");
}
/**
* Check one delivered file against its timeline and its subtitle.
* @param input - The resolved call.
* @returns The canonical result; every failed check carries its own Chinese repair instruction.
* @throws {Error} When the delivered file cannot be probed or a detection pass fails.
*/
async function verifyEpisode(input) {
	const timeline = await readTimeline(input.timelinePath);
	const expectedDurationSeconds = Number((timeline.bodyEndSeconds + 2).toFixed(6));
	const probed = await probeMedia(input.toolkit, input.output);
	const video = firstStreamOfType(probed, "video");
	const audio = firstStreamOfType(probed, "audio");
	const media = {
		durationSeconds: probed.durationSeconds,
		sizeBytes: probed.sizeBytes,
		bitrateBps: probed.bitRateBps,
		videoCodec: video?.codecName ?? "",
		width: video?.width ?? 0,
		height: video?.height ?? 0,
		fps: frameRateOf(video),
		hasAudio: audio !== void 0,
		audioCodec: audio?.codecName ?? "",
		audioSampleRate: audio?.sampleRate ?? 0
	};
	const black = await detectBlackSegments(input.toolkit, input.output, media.durationSeconds);
	const silence = await detectSilenceSegments(input.toolkit, input.output, media.durationSeconds);
	const cues = await readSubtitleCues(input.subtitleSrt);
	const checks = [
		...deliveryChecks(media, expectedDurationSeconds),
		...await videoBanChecks(input, timeline.clips.map((clip) => clip.shot)),
		verdict("black_frames", "failure", longestSeconds(black) < BLACK_FAILURE_SECONDS, describeSegments(black), `检出持续 ${String(BLACK_FAILURE_SECONDS)} 秒以上的黑场。请检查对应时间点的源镜头是否本身是黑场或丢帧，修好素材后重跑 render。`),
		verdict("fade_to_black", "warning", longestSeconds(black) < BLACK_WARNING_SECONDS, describeSegments(black), `检出持续 ${String(BLACK_WARNING_SECONDS)} 秒以上的黑场，未达失败线但值得确认画面对不对。`),
		verdict("silence", "failure", longestSeconds(silence) < SILENCE_FAILURE_SECONDS, describeSegments(silence), `检出持续 ${String(SILENCE_FAILURE_SECONDS)} 秒以上的静音。请检查整集原声是否缺段（audio/<集>.wav 是否由 prepare 完整拼出），修好后重跑 render。`),
		verdict("long_pauses", "warning", longestSeconds(silence) < SILENCE_WARNING_SECONDS, describeSegments(silence), `检出持续 ${String(SILENCE_WARNING_SECONDS)} 秒以上的静音，未达失败线但值得确认是否符合这集的节奏。`),
		...subtitleChecks(cues, timeline.bodyEndSeconds, media.durationSeconds),
		await provenanceCheck(input)
	];
	const sources = /* @__PURE__ */ new Map();
	return buildReport({
		method: "verify",
		project: input.project,
		episode: input.episode,
		timeline,
		sources,
		expectedDurationSeconds,
		written: [],
		output: input.output,
		encoder: "",
		gpuRequested: false,
		gpuUsed: false,
		encoderFallbackReason: "",
		encodedShots: [],
		reusedShots: [],
		tailFrame: NO_TAIL_FRAME,
		media,
		checks,
		warnings: [],
		logPath: ""
	});
}
//#endregion
//#region lib/types/render.js
/**
* `render`: encode one episode into the delivered file.
*
* The pipeline is the delivery specification, in order: every body clip is
* re-encoded to the delivery geometry under its own timeline duration, the ending
* is rebuilt from the last body shot's *proved* tail frame, the body and the
* ending are concatenated with stream copy, the ASS script is burned in, and the
* three audio sources are mixed and muxed with a fast-start index. The result is
* then measured and judged against the delivery specification.
*
* Everything that makes the render impossible — a missing input, a failed
* command, an unprovable tail frame — throws. The delivered file's own
* properties do not: a file that misses the bitrate floor is reported with
* `ok: false` and its repair instructions, because the operator still needs the
* file and the measurement.
*
* @module @deepseek-ai/dsh-tool-episode-render/render
*/
/** Microseconds in one second. */
const MICROSECONDS_PER_SECOND = 1e6;
/** Fail loud when one required input is not a readable file. */
async function requireFile(path, label, fix) {
	let size = 0;
	try {
		size = (await stat(path)).size;
	} catch {
		throw new Error(`${label}不存在或不可读：${path}。${fix}`);
	}
	if (size === 0) throw new Error(`${label}是空文件：${path}。${fix}`);
}
/** One line of the concat list, in the form the concat demuxer reads. */
function concatLine(path) {
	return `file '${path.split("\\").join("/")}'`;
}
/** Read the delivered file's measurable facts. */
async function measure(toolkit, output) {
	const probed = await probeMedia(toolkit, output);
	const video = firstStreamOfType(probed, "video");
	const audio = firstStreamOfType(probed, "audio");
	return {
		durationSeconds: probed.durationSeconds,
		sizeBytes: probed.sizeBytes,
		bitrateBps: probed.bitRateBps,
		videoCodec: video?.codecName ?? "",
		width: video?.width ?? 0,
		height: video?.height ?? 0,
		fps: frameRateOf(video),
		hasAudio: audio !== void 0,
		audioCodec: audio?.codecName ?? "",
		audioSampleRate: audio?.sampleRate ?? 0
	};
}
/** Render one line of the render log for a verdict. */
function logCheck(check) {
	return `check ${check.id} ${check.ok ? "ok" : "FAILED"} ${check.detail}`;
}
/**
* Encode one episode into the delivered file and judge the result.
* @param input - The resolved call.
* @returns The canonical result; `ok` is false when a delivery check failed.
* @throws {Error} When an input is missing, a command fails, or the tail frame cannot be proved.
*/
async function renderEpisode(input) {
	const { toolkit, settings } = input;
	const paths = episodePaths(input.project, input.episode);
	const clips = selectBodyClips(await readTimeline(input.timelinePath), input.lastShot);
	const selectedVideos = clips.map((clip) => resolve(paths.videoDir, shotFileName(clip.shot)));
	await assertVideosAllowed(input.project, [...selectedVideos, input.endingEffect]);
	const bodyEndSeconds = bodyEndSecondsOf(clips);
	const totalSeconds = bodyEndSeconds + 2;
	const expectedDurationSeconds = Number(totalSeconds.toFixed(6));
	await requireFile(paths.masterAudio, "整集原声 master", "请先跑 prepare 生成 audio/<集>.wav。");
	await requireFile(input.bgm, "BGM", "请给出这部剧实际使用的 BGM 文件路径。");
	await requireFile(input.endingAudio, "片尾音", "请给出片尾音文件路径（技能 assets 目录下的 ending_audio.mp3）。");
	await requireFile(input.endingEffect, "片尾特效", "请给出片尾特效文件路径（技能 assets 目录下的 ending_effect.mp4）。");
	const bgmPlan = await readBgmPlan(input.bgmPlan, input.episode, bodyEndSeconds, input.bgm, input.project);
	const choice = await chooseEncoder(toolkit, settings.preferNvenc);
	const gpuUsed = choice.encoder !== "libx264";
	await mkdir(paths.cacheDir, { recursive: true });
	await mkdir(dirname(input.output), { recursive: true });
	const log = [
		`episode=${input.episode}`,
		`project=${input.project}`,
		`bgm_plan=${JSON.stringify(bgmPlan)}`,
		`encoder=${choice.encoder} gpu_requested=${String(settings.preferNvenc)} gpu_used=${String(gpuUsed)}`,
		`encoder_fallback_reason=${choice.fallbackReason === "" ? "(none)" : choice.fallbackReason}`,
		`body_end_seconds=${bodyEndSeconds.toFixed(6)} ending_seconds=${2 .toFixed(3)} expected_duration_seconds=${expectedDurationSeconds.toFixed(6)}`,
		`target_bitrate=24M max_bitrate=30M min_bitrate_bps=${String(MIN_BITRATE_BPS)}`
	];
	const scaleFilter = deliveryScaleFilter();
	const encodedShots = [];
	const reusedShots = [];
	const segments = [];
	const consumedHashes = [await fileSha256(input.endingEffect)];
	for (const clip of clips) {
		const source = resolve(paths.videoDir, shotFileName(clip.shot));
		await requireFile(source, `镜头 ${String(clip.shot)} 的渲染输入`, `请先跑 prepare，把该镜的成片放进 video/${input.episode}/。`);
		const target = resolve(paths.cacheDir, shotFileName(clip.shot));
		const args = [
			"-y",
			"-v",
			"error",
			"-i",
			source,
			"-t",
			(clip.durationUs / MICROSECONDS_PER_SECOND).toFixed(6),
			"-vf",
			scaleFilter,
			"-an",
			"-c:v",
			choice.encoder,
			...choice.args,
			target
		];
		const sourceHash = await fileSha256(source);
		consumedHashes.push(sourceHash);
		await assertVideoHashesAllowed(input.project, [sourceHash]);
		const identity = JSON.stringify([
			sourceHash,
			toolkit.ffmpeg,
			args
		]);
		const sidecar = `${target}.identity`;
		if (!input.force && await pathExists(target) && await readCacheIdentity(sidecar) === identity) reusedShots.push(clip.shot);
		else {
			await rm(sidecar, { force: true });
			await runFfmpeg(toolkit, args);
			await requireFile(target, "编码缓存", "请重跑 render。");
			if (await fileSha256(source) !== sourceHash) throw new Error(`编码期间源视频发生变化：${source}。请重跑 render。`);
			await writeFile(sidecar, identity, "utf8");
			encodedShots.push(clip.shot);
		}
		await assertVideosAllowed(input.project, [target]);
		consumedHashes.push(await fileSha256(target));
		segments.push(target);
	}
	log.push(`encoded_shots=${encodedShots.join(",") || "(none)"} reused_shots=${reusedShots.join(",") || "(none)"}`);
	const tailFrame = await extractTailFrame(toolkit, resolve(paths.videoDir, shotFileName(input.lastShot)), resolve(paths.cacheDir, "last_video_tail_frame.png"));
	log.push(`tail_frame=${tailFrame.path} frame_md5=${tailFrame.frameMd5} sequential_tail_md5=${tailFrame.sequentialTailMd5} from_sequential_decode=${String(tailFrame.fromSequentialDecode)}`);
	const ending = resolve(paths.cacheDir, "ending.mp4");
	await buildEndingClip(toolkit, tailFrame.path, input.endingEffect, ending, choice.encoder, choice.args);
	consumedHashes.push(await fileSha256(ending));
	await assertVideoHashesAllowed(input.project, consumedHashes);
	segments.push(ending);
	const concatFile = resolve(paths.cacheDir, "concat.txt");
	await writeFile(concatFile, `${segments.map(concatLine).join("\n")}\n`, "utf8");
	const base = resolve(paths.cacheDir, "base.mp4");
	await runFfmpeg(toolkit, [
		"-y",
		"-v",
		"error",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		concatFile,
		"-c",
		"copy",
		base
	]);
	const cues = await readSubtitleCues(input.subtitleSrt);
	const ass = resolve(paths.cacheDir, "display.ass");
	await writeFile(ass, `\ufeff${buildAssDocument(cues, settings)}`, "utf8");
	const subtitled = resolve(paths.cacheDir, "subtitled.mp4");
	await runFfmpeg(toolkit, [
		"-y",
		"-v",
		"error",
		"-i",
		base,
		"-vf",
		subtitleBurnFilter(ass, settings.fontsDir),
		"-an",
		"-c:v",
		choice.encoder,
		...choice.args,
		subtitled
	]);
	consumedHashes.push(await fileSha256(subtitled));
	await assertVideoHashesAllowed(input.project, consumedHashes);
	await assertVideosAllowed(input.project, [
		...selectedVideos,
		...segments,
		subtitled,
		input.endingEffect
	]);
	const staging = await mkdtemp(resolve(dirname(input.output), ".drama-render-"));
	const stagedOutput = resolve(staging, "output.mp4");
	try {
		await runFfmpeg(toolkit, [
			"-y",
			"-v",
			"error",
			"-i",
			subtitled,
			"-i",
			paths.masterAudio,
			"-stream_loop",
			"-1",
			"-i",
			input.bgm,
			"-i",
			input.endingAudio,
			"-filter_complex",
			audioMixFilter({
				bodyEndSeconds,
				totalSeconds,
				endingSeconds: 2,
				masterVolume: settings.masterVolume,
				bgmVolume: settings.bgmVolume
			}),
			"-map",
			"0:v:0",
			"-map",
			"[a]",
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-b:a",
			"192k",
			"-ar",
			"48000",
			"-movflags",
			"+faststart",
			stagedOutput
		]);
		consumedHashes.push(await fileSha256(stagedOutput));
		await withFileLock(resolve(input.project, "video-bans.json"), async () => {
			await assertVideoHashesAllowed(input.project, consumedHashes);
			await rename(stagedOutput, input.output);
		});
	} finally {
		await rm(staging, {
			recursive: true,
			force: true
		});
	}
	await writeFile(paths.renderLog, `${log.join("\n")}\n`, "utf8");
	const media = await measure(toolkit, input.output);
	const checks = deliveryChecks(media, expectedDurationSeconds);
	log.push(`output=${input.output} size_bytes=${String(media.sizeBytes)} bitrate_bps=${String(media.bitrateBps)} duration_seconds=${media.durationSeconds.toFixed(6)}`);
	log.push(...checks.map(logCheck));
	await appendFile(paths.renderLog, `${log.join("\n")}\n`, "utf8");
	const provenancePath = provenancePathFor(input.output);
	await writeProvenance(provenancePath, buildProvenance({
		episode: input.episode,
		output: input.output,
		outputSha256: await fileSha256(input.output),
		sizeBytes: media.sizeBytes,
		durationSeconds: media.durationSeconds,
		inputs: consumedHashes,
		encoder: choice.encoder,
		checks,
		now: /* @__PURE__ */ new Date()
	}));
	const sources = new Map(clips.map((clip) => [clip.shot, resolve(paths.videoDir, shotFileName(clip.shot))]));
	return buildReport({
		method: "render",
		bgmPlan,
		project: input.project,
		episode: input.episode,
		timeline: {
			clips,
			bodyEndSeconds
		},
		sources,
		expectedDurationSeconds,
		written: [
			input.output,
			provenancePath,
			paths.renderLog
		],
		output: input.output,
		encoder: choice.encoder,
		gpuRequested: settings.preferNvenc,
		gpuUsed,
		encoderFallbackReason: choice.fallbackReason,
		encodedShots,
		reusedShots,
		tailFrame,
		media,
		checks,
		warnings: tailFrame.fromSequentialDecode ? ["sseof 抽到的帧不是真实尾帧，已改用顺序解码的最后一帧作为片尾定格（见 tail_frame 字段）。"] : [],
		logPath: paths.renderLog
	});
}
//#endregion
//#region lib/types/index.js
/**
* `drama_render`: the short-drama pipeline's episode renderer, as one
* model-facing tool.
*
* The delivery style used to be encoded in a skill script the model launched
* with a shell. The style itself is a fixed specification — 1440x2560 at 60 fps,
* 24M target with a 30M ceiling and a 4.6 Mbps floor, 68px subtitles with -2 spacing
* and a 7px outline, the bottom-right `内容由AI生成` mark, and a two-second ending
* frozen from the last body shot's real tail frame — so it lives here as
* constants, and the operation that produces the delivery is the operation that
* enforces it.
*
* `subtitles`, `prepare`, and `render` write; `verify` only reads. Everything that makes a
* render impossible throws with a Chinese repair instruction. The delivered
* file's own properties do not throw: `render` and `verify` report them as
* checks, so one call tells the operator everything that needs fixing while
* still handing back the file and its measurements.
*
* @module @deepseek-ai/dsh-tool-episode-render
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "tool-episode-render";
/** The tool registry this plugin contributes `drama_render` to. */
const inject = ["tools"];
/** ffmpeg executable used when the deployment does not name one. */
const DEFAULT_FFMPEG = "ffmpeg";
/** ffprobe executable used when the deployment does not name one. */
const DEFAULT_FFPROBE = "ffprobe";
/** Gain applied to the episode's own master audio, as the operator approved it. */
const DEFAULT_MASTER_VOLUME = 1.45;
/** Gain applied to the BGM bed, as the operator approved it. */
const DEFAULT_BGM_VOLUME = .24;
/** Font directory used when the deployment does not name one. */
const DEFAULT_FONTS_DIR = "C:/Windows/Fonts";
/** Default ASS font families for deployments without overrides. */
const DEFAULT_SUBTITLE_FONT_FAMILY = "SimHei";
const DEFAULT_WATERMARK_FONT_FAMILY = "Microsoft YaHei";
/** ASS font names must contain visible text and cannot inject fields or lines. */
const FONT_FAMILY_PATTERN = /^(?=[^,\r\n]*\S)[^,\r\n]+$/u;
/** Validated deployment config, including gain ranges and ASS-safe font families. */
const Config = z.object({
	ffmpegPath: z.string().default(DEFAULT_FFMPEG),
	ffprobePath: z.string().default(DEFAULT_FFPROBE),
	masterVolume: z.number().min(0).max(8).default(DEFAULT_MASTER_VOLUME),
	bgmVolume: z.number().min(0).max(8).default(DEFAULT_BGM_VOLUME),
	preferNvenc: z.boolean().default(true),
	fontsDir: z.string().default(DEFAULT_FONTS_DIR),
	subtitleFontFamily: z.string().pattern(FONT_FAMILY_PATTERN).default(DEFAULT_SUBTITLE_FONT_FAMILY),
	watermarkFontFamily: z.string().pattern(FONT_FAMILY_PATTERN).default(DEFAULT_WATERMARK_FONT_FAMILY)
});
/**
* Resolve one call's configuration into the settings every method takes.
* @param config - The validated plugin config.
* @returns The binaries, gains, encoder preference, font directory and families.
*/
function resolveSettings(config = {}) {
	return {
		ffmpeg: config.ffmpegPath ?? DEFAULT_FFMPEG,
		ffprobe: config.ffprobePath ?? DEFAULT_FFPROBE,
		masterVolume: config.masterVolume ?? DEFAULT_MASTER_VOLUME,
		bgmVolume: config.bgmVolume ?? DEFAULT_BGM_VOLUME,
		preferNvenc: config.preferNvenc ?? true,
		fontsDir: config.fontsDir ?? DEFAULT_FONTS_DIR,
		subtitleFontFamily: config.subtitleFontFamily ?? DEFAULT_SUBTITLE_FONT_FAMILY,
		watermarkFontFamily: config.watermarkFontFamily ?? DEFAULT_WATERMARK_FONT_FAMILY
	};
}
/** Demand one argument a method cannot run without. */
function required(value, method, field, fix) {
	if (value === void 0) throw new Error(`drama_render ${method} 需要 ${field}：${fix}`);
	return value;
}
/**
* Narrow one call's arguments to the paths its method cannot run without.
*
* Each method's own requirements are checked before any file is opened, so a
* missing argument is one readable message rather than a failed command later.
* @param args - The dispatched arguments.
* @returns The resolved call, with every path absolute.
* @throws {Error} When the method's required arguments are missing or the episode number is not a positive integer.
*/
function resolveCall(args) {
	if (!Number.isInteger(args.episode) || args.episode < 1) throw new Error(`drama_render 的 episode 必须是正整数集号，收到 ${JSON.stringify(args.episode)}。请填 1、2、3 这样的集号，工具会补成两位（01、02、03）。`);
	const project = resolve(args.project);
	const episode = episodeNumberOf(args.episode);
	const paths = episodePaths(project, episode);
	if (args.method === "prepare") return {
		method: "prepare",
		project,
		episode,
		shotsPath: resolve(required(args.shots, "prepare", "shots", "成片清单的路径，内容形如 {\"shots\":[{\"shot\":1,\"video\":\"media/02/p1-clean.mp4\"}]}。")),
		subtitleSrt: resolve(required(args.subtitleSrt, "prepare", "subtitleSrt", "本集 SRT 字幕的路径，prepare 会把它装到 editing/<集>.srt 供烧录。"))
	};
	if (args.method === "subtitles") return {
		method: "subtitles",
		project,
		episode,
		shotsPath: resolve(required(args.shots, "subtitles", "shots", "成片清单的路径，内容形如 {\"shots\":[{\"shot\":1,\"video\":\"media/02/p1-clean.mp4\"}]}。")),
		linesPath: resolve(required(args.lines, "subtitles", "lines", "台词计划的路径，内容形如 {\"shots\":[{\"shot\":1,\"lines\":[\"第一句\",\"第二句\"]}]}；每镜的台词要在这里按字幕条切好。")),
		alignmentPath: resolve(required(args.alignment, "subtitles", "alignment", "语音识别对齐文档的路径，内容形如 {\"shots\":[{\"shot\":1,\"cues\":[{\"text\":\"识别文本\",\"start\":0.0,\"end\":0.8}]}]}；每镜的时间必须来自对该镜成片的识别，镜内相对秒数；字幕文字仍取 lines 里的剧本原文。")),
		subtitleSrt: resolve(args.subtitleSrt ?? paths.subtitle)
	};
	if (args.method === "render") {
		const lastShot = required(args.lastShot, "render", "lastShot", "本集最后一个镜头号，例如 9；时间线里 shot <= lastShot 的镜头数必须正好等于它。");
		if (!Number.isInteger(lastShot) || lastShot < 1) throw new Error(`drama_render render 的 lastShot 必须是正整数镜头号，收到 ${JSON.stringify(lastShot)}。`);
		return {
			method: "render",
			project,
			episode,
			timelinePath: resolve(required(args.timeline, "render", "timeline", "时间线 JSON 的路径，通常是 prepare 写出的 editing/<集>-timeline.json。")),
			subtitleSrt: resolve(required(args.subtitleSrt, "render", "subtitleSrt", "本集 SRT 字幕的路径，通常是 prepare 装好的 editing/<集>.srt。")),
			lastShot,
			bgm: resolve(required(args.bgm, "render", "bgm", "本集实际使用的 BGM 文件路径。")),
			...args.bgmPlan === void 0 ? {} : { bgmPlan: resolve(args.bgmPlan) },
			endingAudio: resolve(required(args.endingAudio, "render", "endingAudio", "片尾音文件路径（技能的 assets/ending_audio.mp3）。")),
			endingEffect: resolve(required(args.endingEffect, "render", "endingEffect", "片尾特效文件路径（技能的 assets/ending_effect.mp4）。")),
			output: resolve(args.output ?? paths.output),
			force: args.force ?? false
		};
	}
	return {
		method: "verify",
		project,
		episode,
		timelinePath: resolve(required(args.timeline, "verify", "timeline", "被检查成片所依据的时间线 JSON 路径。")),
		subtitleSrt: resolve(required(args.subtitleSrt, "verify", "subtitleSrt", "被检查成片所烧录的 SRT 字幕路径。")),
		output: resolve(required(args.output, "verify", "output", "要检查的成片文件路径，例如 export/<剧名>_第02集_成片.mp4。"))
	};
}
/** The result of a `prepare` call that wrote nothing but its own layout. */
function prepareReport(call, prepared) {
	const sources = new Map(prepared.shots.map((shot) => [shot.source.shot, shot.video]));
	return buildReport({
		method: "prepare",
		project: call.project,
		episode: call.episode,
		timeline: prepared.timeline,
		sources,
		expectedDurationSeconds: prepared.timeline.bodyEndSeconds,
		written: prepared.written,
		output: "",
		encoder: "",
		gpuRequested: false,
		gpuUsed: false,
		encoderFallbackReason: "",
		encodedShots: [],
		reusedShots: [],
		tailFrame: NO_TAIL_FRAME,
		media: NO_MEDIA,
		checks: [],
		warnings: prepared.warnings,
		logPath: ""
	});
}
/**
* The result of a `subtitles` call.
*
* The line-coverage and timing defects become failure checks so `ok` states
* plainly whether every declared line found its alignment and whether the
* written cues fit the episode. How accurate the recognizer's own times are is
* not judged here, so `speech_alignment` stays in `not_checked`.
* @param call - The resolved call.
* @param built - What the cue build read and wrote.
* @returns The canonical report.
*/
function subtitlesReport(call, built) {
	const sources = new Map(built.shots.map((shot) => [shot.source.shot, shot.video]));
	const checks = built.failures.map((failure) => ({
		id: failure.id,
		severity: "failure",
		ok: false,
		detail: failure.detail,
		fix: failure.fix
	}));
	return buildReport({
		method: "subtitles",
		project: call.project,
		episode: call.episode,
		timeline: built.timeline,
		sources,
		expectedDurationSeconds: built.timeline.bodyEndSeconds,
		written: built.written,
		output: "",
		encoder: "",
		gpuRequested: false,
		gpuUsed: false,
		encoderFallbackReason: "",
		encodedShots: [],
		reusedShots: [],
		tailFrame: NO_TAIL_FRAME,
		media: NO_MEDIA,
		checks,
		warnings: built.warnings,
		logPath: ""
	});
}
/**
* Run one `drama_render` call.
* @param args - The dispatched arguments.
* @param settings - The resolved binaries, gains, and encoder preference.
* @returns The canonical result; `ok` is false when a delivery check failed.
* @throws {Error} When an argument is missing, an input is unusable, or a media command fails.
*/
async function runDramaRender(args, settings) {
	const call = resolveCall(args);
	const toolkit = createMediaToolkit({
		ffmpeg: settings.ffmpeg,
		ffprobe: settings.ffprobe,
		channel: settings.channel
	});
	if (call.method === "prepare") return prepareReport(call, await prepareEpisode({
		toolkit,
		project: call.project,
		episode: call.episode,
		shotsPath: call.shotsPath,
		subtitleSrt: call.subtitleSrt
	}));
	if (call.method === "subtitles") return subtitlesReport(call, await buildEpisodeCues({
		toolkit,
		project: call.project,
		episode: call.episode,
		shotsPath: call.shotsPath,
		linesPath: call.linesPath,
		alignmentPath: call.alignmentPath,
		subtitleSrt: call.subtitleSrt
	}));
	if (call.method === "render") return await renderEpisode({
		toolkit,
		settings,
		project: call.project,
		episode: call.episode,
		timelinePath: call.timelinePath,
		subtitleSrt: call.subtitleSrt,
		lastShot: call.lastShot,
		bgm: call.bgm,
		...call.bgmPlan === void 0 ? {} : { bgmPlan: call.bgmPlan },
		endingAudio: call.endingAudio,
		endingEffect: call.endingEffect,
		output: call.output,
		force: call.force
	});
	return await verifyEpisode({
		toolkit,
		settings,
		project: call.project,
		episode: call.episode,
		output: call.output,
		timelinePath: call.timelinePath,
		subtitleSrt: call.subtitleSrt
	});
}
/** One sentence every check field repeats. */
const CHECK_SHAPE = "severity=failure 表示交付不可用（ok=false），warning 只记录不阻塞。";
/** Model-facing result schema: every field of the canonical report, all of them always present. */
const RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		method: {
			type: "string",
			required: true,
			enum: [
				"prepare",
				"render",
				"verify",
				"subtitles"
			],
			description: "产生本结果的操作。"
		},
		ok: {
			type: "boolean",
			required: true,
			description: "是否成功且没有任何 failure 级检查失败；false 时交付不可用，看 failures 里的修法。"
		},
		project: {
			type: "string",
			required: true,
			description: "项目根目录的绝对路径。"
		},
		episode: {
			type: "string",
			required: true,
			description: "两位集号。"
		},
		clips: {
			type: "array",
			required: true,
			description: "本次使用的时间线镜头，按镜头号顺序。",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					shot: {
						type: "integer",
						required: true,
						description: "镜头号。"
					},
					source: {
						type: "string",
						required: true,
						description: "该镜对应的成片路径：prepare 报清单里声明的源文件；render 报 video/<集>/shot_00N.mp4；verify 不解析素材路径，为空串。"
					},
					start_us: {
						type: "integer",
						required: true,
						description: "相对整集起点的微秒偏移。"
					},
					duration_us: {
						type: "integer",
						required: true,
						description: "该镜占用的微秒数。"
					}
				}
			}
		},
		body_end_seconds: {
			type: "number",
			required: true,
			description: "正片（不含片尾）结束时刻，秒。"
		},
		expected_duration_seconds: {
			type: "number",
			required: true,
			description: "正片结束 + 片尾 2 秒，成片必须达到的时长。"
		},
		written: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "本次写入的绝对路径；verify 不写任何文件。"
		},
		output: {
			type: "string",
			required: true,
			description: "成片绝对路径；prepare 与 verify 之外的场合为空串。"
		},
		encoder: {
			type: "string",
			required: true,
			description: "本次使用的编码器：h264_nvenc 或 libx264；没渲染时为空串。"
		},
		gpu_requested: {
			type: "boolean",
			required: true,
			description: "本次是否请求了 GPU 编码器。"
		},
		gpu_used: {
			type: "boolean",
			required: true,
			description: "GPU 编码器是否真的用上了。"
		},
		encoder_fallback_reason: {
			type: "string",
			required: true,
			description: "回退到 CPU 编码器的原因（探测失败原文）；用上 GPU 或没渲染时为空串。"
		},
		encoded_shots: {
			type: "array",
			required: true,
			items: { type: "integer" },
			description: "本次实际重编的镜头号。"
		},
		reused_shots: {
			type: "array",
			required: true,
			items: { type: "integer" },
			description: "本次复用渲染缓存的镜头号。"
		},
		tail_frame: {
			type: "object",
			required: true,
			description: "片尾定格帧的来源与校验证据；没做片尾时各字段为空值。",
			additionalProperties: false,
			properties: {
				path: {
					type: "string",
					required: true,
					description: "抽出的尾帧 PNG 绝对路径。"
				},
				frame_md5: {
					type: "string",
					required: true,
					description: "实际写入帧的 framemd5。"
				},
				sequential_tail_md5: {
					type: "string",
					required: true,
					description: "顺序解码后最后一帧的 framemd5，即真实尾帧的指纹。"
				},
				from_sequential_decode: {
					type: "boolean",
					required: true,
					description: "是否因为 -sseof 抽到的不是尾帧而改用顺序解码取帧。"
				},
				matches_sequential_tail: {
					type: "boolean",
					required: true,
					description: "写入的帧是否与顺序解码的最后一帧逐像素一致。"
				}
			}
		},
		media: {
			type: "object",
			required: true,
			description: "成片的实测参数；没测量时各字段为空值。",
			additionalProperties: false,
			properties: {
				duration_seconds: {
					type: "number",
					required: true,
					description: "实测总时长，秒。"
				},
				size_bytes: {
					type: "integer",
					required: true,
					description: "文件字节数。"
				},
				bitrate_bps: {
					type: "number",
					required: true,
					description: "实测总码率，bit/s。"
				},
				video_codec: {
					type: "string",
					required: true,
					description: "视频编码器名。"
				},
				width: {
					type: "integer",
					required: true,
					description: "画面宽度。"
				},
				height: {
					type: "integer",
					required: true,
					description: "画面高度。"
				},
				fps: {
					type: "number",
					required: true,
					description: "实测帧率。"
				},
				has_audio: {
					type: "boolean",
					required: true,
					description: "是否带音轨。"
				},
				audio_codec: {
					type: "string",
					required: true,
					description: "音频编码器名。"
				},
				audio_sample_rate: {
					type: "integer",
					required: true,
					description: "音频采样率，Hz。"
				}
			}
		},
		checks: {
			type: "array",
			required: true,
			description: `本次跑过的检查。${CHECK_SHAPE}`,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true,
						description: "稳定的检查名：duration、video_stream、frame_rate、audio_stream、bitrate_floor、black_frames、fade_to_black、silence、long_pauses、subtitle_bounds、subtitle_present。"
					},
					severity: {
						type: "string",
						required: true,
						enum: ["failure", "warning"],
						description: CHECK_SHAPE
					},
					ok: {
						type: "boolean",
						required: true,
						description: "该检查是否通过。"
					},
					detail: {
						type: "string",
						required: true,
						description: "判定所依据的实测值。"
					},
					fix: {
						type: "string",
						required: true,
						description: "中文修法；通过时为空串。"
					}
				}
			}
		},
		bgm_plan: {
			type: "object",
			required: true,
			additionalProperties: false,
			description: "声明的配乐段落和同序曲目复用提醒；不是试听结论。未提供计划时为空值。",
			properties: {
				path: {
					type: "string",
					required: true
				},
				bed_sha256: {
					type: "string",
					required: true
				},
				repeated_sequence_episodes: {
					type: "array",
					required: true,
					items: { type: "string" }
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
								required: true
							},
							source: {
								type: "string",
								required: true
							},
							start_seconds: {
								type: "number",
								required: true
							},
							end_seconds: {
								type: "number",
								required: true
							},
							reason: {
								type: "string",
								required: true
							}
						}
					}
				}
			}
		},
		not_checked: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "本次未测量的 QA 项；ok=true 只表示已执行检查通过，不代表内容、字幕或配乐全部通过。"
		},
		failures: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "每条 failure 级失败一行中文说明与修法。"
		},
		warnings: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "每条不阻塞的提醒一行中文说明。"
		},
		log_path: {
			type: "string",
			required: true,
			description: "渲染日志绝对路径（含编码器回退原因与逐项检查结论）；没写日志时为空串。"
		},
		summary: {
			type: "object",
			required: true,
			additionalProperties: false,
			properties: {
				shots: {
					type: "integer",
					required: true,
					description: "时间线镜头数。"
				},
				encoded: {
					type: "integer",
					required: true,
					description: "本次重编的镜头数。"
				},
				reused: {
					type: "integer",
					required: true,
					description: "本次复用缓存的镜头数。"
				},
				checks: {
					type: "integer",
					required: true,
					description: "检查数。"
				},
				failed_checks: {
					type: "integer",
					required: true,
					description: "未通过的检查数（含 warning）。"
				},
				warnings: {
					type: "integer",
					required: true,
					description: "提醒条数。"
				}
			}
		}
	}
};
/** What the model reads before calling: the four methods, the fixed style, and the two known traps. */
const DESCRIPTION = "短剧整集渲染编排（剧变流水线）。subtitles=按语音识别对齐写出 SRT：对齐文档（alignment）给出每一镜每一句的说话时间，字幕文字只取 lines 里的剧本原文，cue 时间 = 该镜在时间线上的起点 + 镜内偏移。**本工具不做识别、不测能量、不估算时间**：能量门限分不出具体哪句在哪里，估算出来的时间正是字幕压在错句上的原因。缺某一镜的对齐、段数与台词条数不符、识别文本与剧本对不上，都按 failure 报出（subtitle_line_coverage），并指出该对哪一镜重跑识别；有识别结果却没声明台词，同样报 failure。写出的每条字幕还会检查时长、重叠、越界与阅读速度（超过 20 字/秒按 failure，超过 12 字/秒按 warning）。对齐时间本身的准确度不由本工具判断，识别模型与语言选择由调用方负责。prepare=按成片清单构建渲染输入：把每镜成片复制到 video/<集>/shot_00N.mp4，按 ffprobe 实测时长铺时间线（editing/<集>-timeline.json），把每镜自己的声音按各自起点拼成整集原声 master（audio/<集>.wav，48kHz 无损、不加增益、不逐镜重采样），并安装 SRT 到 editing/<集>.srt；不编码画面。render=出片：逐镜编码到交付规格 1440x2560@60、24M 目标码率 / 30M 上限 / 48M 缓冲、H.264 high@5.1，片尾用最后一镜的真实尾帧定格 2 秒并叠 ending_effect，拼接后烧录 ASS 字幕（默认 SimHei 68，字体服从部署配置；字间距 -2、7px 黑描边、底部居中，右下角唯一的「内容由AI生成」标记），再把整集原声（增益 1.45）+ BGM（增益 0.24，到正片结束）+ 片尾音 amix 后 alimiter=0.95，AAC 192k/48kHz、+faststart 输出，并回读实测分辨率/帧率/码率/时长/大小/编码器。GPU 编码先探测 h264_nvenc（用 256x256 探针，太小会被 NVENC 拒绝），失败就按设计回退 libx264，回退原因写进 encoder_fallback_reason 与渲染日志。verify=渲染后检查：总时长、音视频流、总码率下限 4.6 Mbps、黑帧、静音、字幕 cue 是否越界，逐项给实测值与中文修法。抽尾帧固定用 -sseof -0.1：-sseof -0.05 在部分片子上不写文件却返回 0，所以每次都用 framemd5 与顺序解码的最后一帧比对，证明抽到的是真实尾帧，比对不上就改用顺序解码取帧。只有让渲染无法进行的问题（缺参数、缺文件、命令失败、尾帧无法证明）才会报错；成片本身的问题按 checks 返回，ok=false 并在 failures 里给出中文修法，成片与实测参数照常返回。";
/**
* Register the `drama_render` tool.
* @param ctx - Host context carrying the tool registry.
* @param config - The deployment-varying binaries, gains, and encoder preference.
*/
function apply(ctx, config = {}) {
	const settings = resolveSettings(config);
	registerDramaVideo(ctx);
	ctx.tools.register(defineTool({
		name: "drama_render",
		description: DESCRIPTION,
		parameters: {
			method: {
				type: "string",
				required: true,
				enum: [
					"prepare",
					"render",
					"verify",
					"subtitles"
				],
				description: "prepare=构建渲染输入（不编码）；render=出片并回读实测参数；verify=渲染后检查；subtitles=按语音识别对齐文档给台词定时并写出 SRT（不编码、不做识别）。"
			},
			project: {
				type: "string",
				required: true,
				description: "项目根目录（含 video/、audio/、editing/、exports/）；四个方法都必填。"
			},
			episode: {
				type: "integer",
				required: true,
				description: "集号（正整数，如 2）；写入时补成两位，如 02。"
			},
			shots: {
				type: "string",
				description: "成片清单 JSON 路径，形如 {\"shots\":[{\"shot\":1,\"video\":\"media/02/p1-clean.mp4\",\"audio\":\"可选\"}]}；prepare 与 subtitles 必填。video 缺音轨时必须给 audio。"
			},
			lines: {
				type: "string",
				description: "台词计划 JSON 路径，形如 {\"shots\":[{\"shot\":1,\"lines\":[\"第一句\",\"第二句\"]}]}；subtitles 必填。每镜的台词在这里就按字幕条切好（单条不超过 14 个字），工具只给时间，不改文字。"
			},
			alignment: {
				type: "string",
				description: "语音识别对齐文档 JSON 路径，subtitles 必填，形如 {\"shots\":[{\"shot\":1,\"cues\":[{\"text\":\"识别文本\",\"start\":0.0,\"end\":0.8}]}]}（镜内、相对该镜起点，秒）。只取它的时间：字幕文字仍来自 lines，识别文本仅用于核对是不是同一段表演。缺某一镜、段数与台词条数不符、或文本对不上，都会按 failure 报出。"
			},
			timeline: {
				type: "string",
				description: "时间线 JSON 路径；render 与 verify 必填，通常是 prepare 写出的 editing/<集>-timeline.json。"
			},
			subtitle_srt: {
				type: "string",
				description: "本集 SRT 字幕路径；subtitles 写出它（省略时写 editing/<集>.srt），prepare 装到 editing/<集>.srt，render 烧录它，verify 检查它的 cue 是否越界。"
			},
			last_shot: {
				type: "integer",
				description: "本次交付的最后一个镜头号（如 9）；render 必填，时间线里 shot <= last_shot 的镜头数必须正好等于它。"
			},
			bgm: {
				type: "string",
				description: "本集实际使用的 BGM 文件路径；render 必填，会循环铺到正片结束。"
			},
			bgm_plan: {
				type: "string",
				description: "render 可选：现有 episodes/segments 配乐计划 JSON；校验时间、记录曲目与复用提醒，不代替试听。"
			},
			ending_audio: {
				type: "string",
				description: "片尾音文件路径；render 必填。"
			},
			ending_effect: {
				type: "string",
				description: "片尾特效视频路径；render 必填。"
			},
			output: {
				type: "string",
				description: "成片输出路径；render 省略时写 exports/<集>.mp4，verify 必填（要检查哪个文件）。"
			},
			force: {
				type: "boolean",
				description: "render 是否忽略 exports/.render_cache 里的逐镜缓存并全部重编；默认 false。"
			}
		},
		output: {
			schema: RESULT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async ({ subtitle_srt, last_shot, ending_audio, ending_effect, bgm_plan, ...args }) => await runDramaRender({
			...args,
			...subtitle_srt === void 0 ? {} : { subtitleSrt: subtitle_srt },
			...bgm_plan === void 0 ? {} : { bgmPlan: bgm_plan },
			...last_shot === void 0 ? {} : { lastShot: last_shot },
			...ending_audio === void 0 ? {} : { endingAudio: ending_audio },
			...ending_effect === void 0 ? {} : { endingEffect: ending_effect }
		}, settings)
	}));
}
//#endregion
export { Config, apply, inject, name, resolveCall, resolveSettings, runDramaRender };
