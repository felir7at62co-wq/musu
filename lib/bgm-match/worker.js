import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
//#region lib/types/worker.js
/**
* One resident Python process for emotion analysis.
*
* Resident because loading MERT costs about 10–16 seconds; a per-call spawn would
* pay that fixed cost for every track. The protocol is newline-delimited JSON in
* both directions. The child starts with `-I -B -X utf8` under a scrubbed
* environment, matching the harness' other Python workers: no inherited API
* keys, proxy credentials or DSH session facts reach model code.
*
* A timeout kills the process. Python inference cannot be interrupted safely at
* the thread level, and leaving half a JSON stream alive would poison every
* request after it.
*/
const DEFAULT_READY_TIMEOUT = 6e4;
const DEFAULT_CALL_TIMEOUT = 3e5;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Long-lived NDJSON bridge to `worker_main.py`. */
var EmotionWorker = class {
	options;
	child;
	reader;
	pending = /* @__PURE__ */ new Map();
	counter = 0;
	ready;
	/** In-flight start, so concurrent callers share one process instead of racing. */
	startPromise;
	dead = false;
	constructor(options) {
		this.options = options;
	}
	/** Whether the process can accept another call. */
	get alive() {
		return !this.dead && this.child !== void 0 && this.child.exitCode === null;
	}
	/**
	* Start once and wait for the worker's dependency handshake.
	* @returns The shared startup report, including any missing dependencies.
	*/
	async start() {
		if (this.ready !== void 0) return this.ready;
		if (this.startPromise !== void 0) return await this.startPromise;
		this.startPromise = this.startOnce();
		try {
			this.ready = await this.startPromise;
			return this.ready;
		} finally {
			this.startPromise = void 0;
		}
	}
	/**
	* Send one request; callers must await {@link start} first.
	* @param method - Python worker operation name.
	* @param params - JSON-serializable arguments for that operation.
	* @returns The decoded result, or a rejection on worker error, timeout, or process exit.
	*/
	async call(method, params) {
		if (!this.alive) throw new Error("worker is not running");
		const child = this.child;
		const stdin = child?.stdin;
		if (child === void 0 || stdin === null || stdin === void 0) throw new Error("worker stdin is unavailable");
		this.counter += 1;
		const id = `c${this.counter}`;
		const timeout = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.kill();
				reject(/* @__PURE__ */ new Error(`worker call "${method}" timed out after ${timeout} ms`));
			}, timeout);
			this.pending.set(id, {
				resolve,
				reject,
				timer
			});
			stdin.write(`${JSON.stringify({
				id,
				method,
				params
			})}\n`);
		});
	}
	/** Stop the process and reject every outstanding request. */
	dispose() {
		this.kill();
		this.failAll(/* @__PURE__ */ new Error("worker disposed"));
		return Promise.resolve();
	}
	async startOnce() {
		const readyTimeout = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT;
		const handshake = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete("__handshake__");
				this.kill();
				reject(/* @__PURE__ */ new Error("worker handshake timeout"));
			}, readyTimeout);
			this.pending.set("__handshake__", {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				timer
			});
		});
		const argv = [
			this.options.pythonExecutable,
			"-I",
			"-B",
			"-X",
			"utf8",
			this.options.scriptPath
		];
		const env = { ...this.options.env };
		for (const key of [
			"SystemRoot",
			"WINDIR",
			"SYSTEMROOT",
			"PATH",
			"TEMP",
			"TMP",
			"HF_HOME",
			"HF_HUB_CACHE",
			"TRANSFORMERS_CACHE",
			"HF_ENDPOINT"
		]) if (process.env[key] !== void 0) env[key] = process.env[key];
		this.options.onLaunch?.(argv, env);
		this.dead = false;
		let child;
		try {
			child = spawn(argv[0] ?? "", argv.slice(1), {
				shell: false,
				windowsHide: true,
				env,
				stdio: [
					"pipe",
					"pipe",
					"pipe"
				]
			});
		} catch {
			this.pending.delete("__handshake__");
			this.dead = true;
			throw new Error("worker failed to start");
		}
		this.child = child;
		child.once("error", () => {
			this.failAll(/* @__PURE__ */ new Error("worker failed to start"));
		});
		child.once("close", () => {
			this.failAll(/* @__PURE__ */ new Error("worker exited"));
		});
		child.stderr?.on("data", () => {});
		if (child.stdout === null) {
			this.failAll(/* @__PURE__ */ new Error("worker stdout is unavailable"));
			return await handshake;
		}
		this.reader = createInterface({ input: child.stdout });
		this.reader.on("line", (line) => {
			this.onLine(line);
		});
		return await handshake;
	}
	onLine(line) {
		if (Buffer.byteLength(line, "utf8") > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
			this.kill();
			this.failAll(/* @__PURE__ */ new Error("worker response exceeded its byte limit"));
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		const id = parsed.id;
		if (id === void 0) return;
		const waiter = this.pending.get(id);
		if (waiter === void 0) return;
		this.pending.delete(id);
		clearTimeout(waiter.timer);
		if (parsed.status === "ok") waiter.resolve(parsed.result);
		else waiter.reject(/* @__PURE__ */ new Error(`${parsed.error?.code ?? "WORKER_ERROR"}: ${parsed.error?.message ?? ""}`));
	}
	kill() {
		this.dead = true;
		this.reader?.close();
		try {
			this.child?.kill("SIGKILL");
		} catch {}
	}
	failAll(error) {
		this.dead = true;
		for (const [, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}
};
//#endregion
export { EmotionWorker };
