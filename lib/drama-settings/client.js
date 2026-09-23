window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-drama-settings",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region ../../../vendor/cosmokit/lib/index.js
		/** Return true when a value is `null` or `undefined`. */
		function isNullable(value) {
			return value === null || value === void 0;
		}
		/** Return true for non-array object values. */
		function isPlainObject(data) {
			return data && typeof data === "object" && !Array.isArray(data);
		}
		/** Filter object entries and return a new object. */
		function filterKeys(object, filter) {
			return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
		}
		/** Map object values while preserving the original key set. */
		function mapValues(object, transform) {
			return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
		}
		/** Pick selected keys from an object, optionally including `undefined` values. */
		function pick(source, keys, forced) {
			if (!keys) return { ...source };
			const result = {};
			for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
			return result;
		}
		/** Test values using `instanceof` with a `toStringTag` fallback. */
		function is(type, value) {
			if (arguments.length === 1) return (value) => is(type, value);
			return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
		}
		function isArrayBufferLike(value) {
			return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
		}
		function isArrayBufferSource(value) {
			return isArrayBufferLike(value) || ArrayBuffer.isView(value);
		}
		/** Binary source detection and base64/hex conversion helpers. */
		var Binary;
		(function(Binary) {
			Binary.is = isArrayBufferLike;
			Binary.isSource = isArrayBufferSource;
			function fromSource(source) {
				if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
				else return source;
			}
			Binary.fromSource = fromSource;
			function toBase64(source) {
				source = fromSource(source);
				if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
				let binary = "";
				const bytes = new Uint8Array(source);
				for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
				return btoa(binary);
			}
			Binary.toBase64 = toBase64;
			function fromBase64(source) {
				if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
				return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
			}
			Binary.fromBase64 = fromBase64;
			function toHex(source) {
				source = fromSource(source);
				if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
				return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
			}
			Binary.toHex = toHex;
			function fromHex(source) {
				if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
				const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
				const buffer = [];
				for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
				return Uint8Array.from(buffer).buffer;
			}
			Binary.fromHex = fromHex;
		})(Binary || (Binary = {}));
		Binary.fromBase64;
		Binary.toBase64;
		Binary.fromHex;
		Binary.toHex;
		/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
		function clone(source, refs = /* @__PURE__ */ new Map()) {
			if (!source || typeof source !== "object") return source;
			if (is("Date", source)) return new Date(source.valueOf());
			if (is("RegExp", source)) return new RegExp(source.source, source.flags);
			if (isArrayBufferLike(source)) return source.slice(0);
			if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
			const cached = refs.get(source);
			if (cached) return cached;
			if (Array.isArray(source)) {
				const result = [];
				refs.set(source, result);
				source.forEach((value, index) => {
					result[index] = Reflect.apply(clone, null, [value, refs]);
				});
				return result;
			}
			const result = Object.create(Object.getPrototypeOf(source));
			refs.set(source, result);
			for (const key of Reflect.ownKeys(source)) {
				const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
				if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
				Reflect.defineProperty(result, key, descriptor);
			}
			return result;
		}
		/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
		function deepEqual(a, b, strict) {
			if (a === b) return true;
			if (!strict && isNullable(a) && isNullable(b)) return true;
			if (typeof a !== typeof b) return false;
			if (typeof a !== "object") return false;
			if (!a || !b) return false;
			function check(test, then) {
				return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
			}
			return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? Object.keys({
				...a,
				...b
			}).every((key) => deepEqual(a[key], b[key], strict));
		}
		/** Time constants plus parsing and formatting helpers. */
		var Time;
		(function(Time) {
			Time.millisecond = 1;
			Time.second = 1e3;
			Time.minute = Time.second * 60;
			Time.hour = Time.minute * 60;
			Time.day = Time.hour * 24;
			Time.week = Time.day * 7;
			let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
			function setTimezoneOffset(offset) {
				timezoneOffset = offset;
			}
			Time.setTimezoneOffset = setTimezoneOffset;
			function getTimezoneOffset() {
				return timezoneOffset;
			}
			Time.getTimezoneOffset = getTimezoneOffset;
			function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
				if (typeof date === "number") date = new Date(date);
				if (offset === void 0) offset = timezoneOffset;
				return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
			}
			Time.getDateNumber = getDateNumber;
			function fromDateNumber(value, offset) {
				const date = new Date(value * Time.day);
				if (offset === void 0) offset = timezoneOffset;
				return new Date(+date + offset * Time.minute);
			}
			Time.fromDateNumber = fromDateNumber;
			const numeric = /\d+(?:\.\d+)?/.source;
			const timeRegExp = new RegExp(`^${[
				"w(?:eek(?:s)?)?",
				"d(?:ay(?:s)?)?",
				"h(?:our(?:s)?)?",
				"m(?:in(?:ute)?(?:s)?)?",
				"s(?:ec(?:ond)?(?:s)?)?"
			].map((unit) => `(${numeric}${unit})?`).join("")}$`);
			function parseTime(source) {
				const capture = timeRegExp.exec(source);
				if (!capture) return 0;
				return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
			}
			Time.parseTime = parseTime;
			function parseDate(date) {
				const parsed = parseTime(date);
				if (parsed) date = Date.now() + parsed;
				else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
				else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
				return date ? new Date(date) : /* @__PURE__ */ new Date();
			}
			Time.parseDate = parseDate;
			function format(ms) {
				const abs = Math.abs(ms);
				if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
				else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
				else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
				else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
				return ms + "ms";
			}
			Time.format = format;
			function toDigits(source, length = 2) {
				return source.toString().padStart(length, "0");
			}
			Time.toDigits = toDigits;
			function template(template, time = /* @__PURE__ */ new Date()) {
				return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
			}
			Time.template = template;
		})(Time || (Time = {}));
		//#endregion
		//#region ../../../vendor/schemastery/lib/index.mjs
		const kSchema = Symbol.for("schemastery");
		const kValidationError = Symbol.for("ValidationError");
		globalThis.__schemastery_index__ ??= 0;
		globalThis.__schemastery_refs__ = void 0;
		var ValidationError = class extends TypeError {
			options;
			name = "ValidationError";
			constructor(message, options) {
				let prefix = "$";
				for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
				else if (typeof segment === "number") prefix += "[" + segment + "]";
				else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
				if (prefix.startsWith(".")) prefix = prefix.slice(1);
				super((prefix === "$" ? "" : `${prefix} `) + message);
				this.options = options;
			}
			static is(error) {
				return !!error?.[kValidationError];
			}
		};
		Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
		const Schema = function(options) {
			const schema = function(data, options = {}) {
				return Schema.resolve(data, schema, options)[0];
			};
			if (options.refs) {
				const refs = mapValues(options.refs, (options) => new Schema(options));
				const getRef = (uid) => refs[uid];
				for (const key in refs) {
					const options = refs[key];
					options.sKey = getRef(options.sKey);
					options.inner = getRef(options.inner);
					options.list = options.list && options.list.map(getRef);
					options.dict = options.dict && mapValues(options.dict, getRef);
				}
				return refs[options.uid];
			}
			Object.assign(schema, options);
			if (typeof schema.callback === "string") try {
				schema.callback = new Function("return " + schema.callback)();
			} catch {}
			Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
			Object.setPrototypeOf(schema, Schema.prototype);
			schema.meta ||= {};
			schema.toString = schema.toString.bind(schema);
			return schema;
		};
		Schema.prototype = Object.create(Function.prototype);
		Schema.prototype[kSchema] = true;
		Object.defineProperty(Schema.prototype, "~standard", { get() {
			return {
				version: 1,
				vendor: "schemastery",
				validate: (value) => {
					try {
						return { value: Schema.resolve(value, this, {})[0] };
					} catch (error) {
						if (ValidationError.is(error)) return { issues: [{
							message: error.message,
							path: error.options.path
						}] };
						throw error;
					}
				}
			};
		} });
		Schema.ValidationError = ValidationError;
		Schema.prototype.toJSON = function toJSON() {
			if (globalThis.__schemastery_refs__) {
				globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
				return this.uid;
			}
			globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
			globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
			const result = {
				uid: this.uid,
				refs: globalThis.__schemastery_refs__
			};
			globalThis.__schemastery_refs__ = void 0;
			return result;
		};
		Schema.prototype.set = function set(key, value) {
			this.dict[key] = value;
			return this;
		};
		Schema.prototype.push = function push(value) {
			this.list.push(value);
			return this;
		};
		function mergeDesc(original, messages) {
			const result = typeof original === "string" ? { "": original } : { ...original };
			for (const locale in messages) {
				const value = messages[locale];
				if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
				else if (typeof value === "string") result[locale] = value;
			}
			return result;
		}
		function getInner(value) {
			return value?.$value ?? value?.$inner;
		}
		function extractKeys(data) {
			return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
		}
		Schema.prototype.i18n = function i18n(messages) {
			const schema = Schema(this);
			const desc = mergeDesc(schema.meta.description, messages);
			if (Object.keys(desc).length) schema.meta.description = desc;
			if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
				return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
			});
			if (schema.list) schema.list = schema.list.map((inner, index) => {
				return inner.i18n(mapValues(messages, (data = {}) => {
					if (Array.isArray(getInner(data))) return getInner(data)[index];
					if (Array.isArray(data)) return data[index];
					return extractKeys(data);
				}));
			});
			if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
				if (getInner(data)) return getInner(data);
				return extractKeys(data);
			}));
			if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
			return schema;
		};
		Schema.prototype.extra = function extra(key, value) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		};
		for (const key of [
			"required",
			"disabled",
			"collapse",
			"hidden",
			"loose"
		]) Object.assign(Schema.prototype, { [key](value = true) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		} });
		Schema.prototype.deprecated = function deprecated() {
			const schema = Schema(this);
			schema.meta.badges ||= [];
			schema.meta.badges.push({
				text: "deprecated",
				type: "danger"
			});
			return schema;
		};
		Schema.prototype.experimental = function experimental() {
			const schema = Schema(this);
			schema.meta.badges ||= [];
			schema.meta.badges.push({
				text: "experimental",
				type: "warning"
			});
			return schema;
		};
		Schema.prototype.pattern = function pattern(regexp) {
			const schema = Schema(this);
			const pattern = pick(regexp, ["source", "flags"]);
			schema.meta = {
				...schema.meta,
				pattern
			};
			return schema;
		};
		Schema.prototype.simplify = function simplify(value) {
			if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
			if (isNullable(value)) return value;
			if (this.type === "object" || this.type === "dict") {
				const result = {};
				for (const key in value) {
					const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
					if (this.type === "dict" || !isNullable(item)) result[key] = item;
				}
				if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
				return result;
			} else if (this.type === "array" || this.type === "tuple") {
				const result = [];
				value.forEach((value, index) => {
					const schema = this.type === "array" ? this.inner : this.list[index];
					const item = schema ? schema.simplify(value) : value;
					result.push(item);
				});
				return result;
			} else if (this.type === "intersect") {
				const result = {};
				for (const item of this.list) Object.assign(result, item.simplify(value));
				return result;
			} else if (this.type === "union") for (const schema of this.list) try {
				Schema.resolve(value, schema, {});
				return schema.simplify(value);
			} catch {}
			return value;
		};
		Schema.prototype.toString = function toString(inline) {
			return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
		};
		Schema.prototype.role = function role(role, extra) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				role,
				extra
			};
			return schema;
		};
		for (const key of [
			"default",
			"link",
			"comment",
			"description",
			"max",
			"min",
			"step"
		]) Object.assign(Schema.prototype, { [key](value) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		} });
		const resolvers = {};
		Schema.extend = function extend(type, resolve) {
			resolvers[type] = resolve;
		};
		Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
			if (!schema) return [data];
			if (options.ignore?.(data, schema)) return [data];
			if (isNullable(data) && schema.type !== "lazy") {
				if (schema.meta.required) throw new ValidationError(`missing required value`, options);
				let current = schema;
				let fallback = schema.meta.default;
				while (current?.type === "intersect" && isNullable(fallback)) {
					current = current.list[0];
					fallback = current?.meta.default;
				}
				if (isNullable(fallback)) return [data];
				data = clone(fallback);
			}
			const callback = resolvers[schema.type];
			if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
			try {
				return callback(data, schema, options, strict);
			} catch (error) {
				if (!schema.meta.loose) throw error;
				return [schema.meta.default];
			}
		};
		Schema.from = function from(source) {
			if (isNullable(source)) return Schema.any();
			else if ([
				"string",
				"number",
				"boolean"
			].includes(typeof source)) return Schema.const(source).required();
			else if (source[kSchema]) return source;
			else if (typeof source === "function") switch (source) {
				case String: return Schema.string().required();
				case Number: return Schema.number().required();
				case Boolean: return Schema.boolean().required();
				case Function: return Schema.function().required();
				default: return Schema.is(source).required();
			}
			else throw new TypeError(`cannot infer schema from ${source}`);
		};
		Schema.lazy = function lazy(builder) {
			const toJSON = () => {
				if (!schema.inner[kSchema]) {
					schema.inner = schema.builder();
					schema.inner.meta = {
						...schema.meta,
						...schema.inner.meta
					};
				}
				return schema.inner.toJSON();
			};
			const schema = new Schema({
				type: "lazy",
				builder,
				inner: { toJSON }
			});
			return schema;
		};
		Schema.natural = function natural() {
			return Schema.number().step(1).min(0);
		};
		Schema.percent = function percent() {
			return Schema.number().step(.01).min(0).max(1).role("slider");
		};
		Schema.date = function date() {
			return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
				const date = new Date(value);
				if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
				return date;
			}, true)]);
		};
		Schema.regExp = function regExp(flag = "") {
			return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
				try {
					return new RegExp(value, flag);
				} catch (e) {
					throw new ValidationError(e.message, options);
				}
			}, true)]);
		};
		Schema.arrayBuffer = function arrayBuffer(encoding) {
			return Schema.union([
				Schema.is(ArrayBuffer),
				Schema.is(SharedArrayBuffer),
				Schema.transform(Schema.any(), (value, options) => {
					if (Binary.isSource(value)) return Binary.fromSource(value);
					throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
				}, true),
				...encoding ? [Schema.transform(Schema.string(), (value, options) => {
					try {
						return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
					} catch (e) {
						throw new ValidationError(e.message, options);
					}
				}, true)] : []
			]);
		};
		Schema.extend("lazy", (data, schema, options, strict) => {
			if (!schema.inner[kSchema]) {
				schema.inner = schema.builder();
				schema.inner.meta = {
					...schema.meta,
					...schema.inner.meta
				};
			}
			return Schema.resolve(data, schema.inner, options, strict);
		});
		Schema.extend("any", (data) => {
			return [data];
		});
		Schema.extend("never", (data, _, options) => {
			throw new ValidationError(`expected nullable but got ${data}`, options);
		});
		Schema.extend("const", (data, { value }, options) => {
			if (deepEqual(data, value)) return [value];
			throw new ValidationError(`expected ${value} but got ${data}`, options);
		});
		function checkWithinRange(data, meta, description, options, skipMin = false) {
			const { max = Infinity, min = -Infinity } = meta;
			if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
			if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
		}
		Schema.extend("string", (data, { meta }, options) => {
			if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
			if (meta.pattern) {
				const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
				if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
			}
			checkWithinRange(data.length, meta, "string length", options);
			return [data];
		});
		function decimalShift(data, digits) {
			const str = data.toString();
			if (str.includes("e")) return data * Math.pow(10, digits);
			const index = str.indexOf(".");
			if (index === -1) return data * Math.pow(10, digits);
			const frac = str.slice(index + 1);
			const integer = str.slice(0, index);
			if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
			return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
		}
		function isMultipleOf(data, min, step) {
			step = Math.abs(step);
			if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
			const index = step.toString().indexOf(".");
			const digits = step.toString().slice(index + 1).length;
			return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
		}
		Schema.extend("number", (data, { meta }, options) => {
			if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
			checkWithinRange(data, meta, "number", options);
			const { step } = meta;
			if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
			return [data];
		});
		Schema.extend("boolean", (data, _, options) => {
			if (typeof data === "boolean") return [data];
			throw new ValidationError(`expected boolean but got ${data}`, options);
		});
		Schema.extend("bitset", (data, { bits, meta }, options) => {
			let value = 0, keys = [];
			if (typeof data === "number") {
				value = data;
				for (const key in bits) if (data & bits[key]) keys.push(key);
			} else if (Array.isArray(data)) {
				keys = data;
				for (const key of keys) {
					if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
					if (key in bits) value |= bits[key];
				}
			} else throw new ValidationError(`expected number or array but got ${data}`, options);
			if (value === meta.default) return [value];
			return [value, keys];
		});
		Schema.extend("function", (data, _, options) => {
			if (typeof data === "function") return [data];
			throw new ValidationError(`expected function but got ${data}`, options);
		});
		Schema.extend("is", (data, { constructor }, options) => {
			if (typeof constructor === "function") {
				if (data instanceof constructor) return [data];
				throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
			} else {
				if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
				let prototype = Object.getPrototypeOf(data);
				while (prototype) {
					if (prototype.constructor?.name === constructor) return [data];
					prototype = Object.getPrototypeOf(prototype);
				}
				throw new ValidationError(`expected ${constructor} but got ${data}`, options);
			}
		});
		function property(data, key, schema, options) {
			try {
				const [value, adapted] = Schema.resolve(data[key], schema, {
					...options,
					path: [...options.path || [], key]
				});
				if (adapted !== void 0) data[key] = adapted;
				return value;
			} catch (e) {
				if (!options?.autofix) throw e;
				delete data[key];
				return schema.meta.default;
			}
		}
		Schema.extend("array", (data, { inner, meta }, options) => {
			if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
			checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
			return [data.map((_, index) => property(data, index, inner, options))];
		});
		Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
			if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
			const result = {};
			for (const key in data) {
				let rKey;
				try {
					rKey = Schema.resolve(key, sKey, options)[0];
				} catch (error) {
					if (strict) continue;
					throw error;
				}
				result[rKey] = property(data, key, inner, options);
				data[rKey] = data[key];
				if (key !== rKey) delete data[key];
			}
			return [result];
		});
		Schema.extend("tuple", (data, { list }, options, strict) => {
			if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
			const result = list.map((inner, index) => property(data, index, inner, options));
			if (strict) return [result];
			result.push(...data.slice(list.length));
			return [result];
		});
		function merge(result, data) {
			for (const key in data) {
				if (key in result) continue;
				result[key] = data[key];
			}
		}
		Schema.extend("object", (data, { dict }, options, strict) => {
			if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
			const result = {};
			for (const key in dict) {
				const value = property(data, key, dict[key], options);
				if (!isNullable(value) || key in data) result[key] = value;
			}
			if (!strict) merge(result, data);
			return [result];
		});
		Schema.extend("union", (data, { list, toString }, options, strict) => {
			const messages = [];
			for (const inner of list) try {
				return Schema.resolve(data, inner, options, strict);
			} catch (error) {
				messages.push(error);
			}
			throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		});
		Schema.extend("intersect", (data, { list, toString }, options, strict) => {
			if (!list.length) return [data];
			let result;
			for (const inner of list) {
				const value = Schema.resolve(data, inner, options, true)[0];
				if (isNullable(value)) continue;
				if (isNullable(result)) result = value;
				else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
				else if (typeof value === "object") merge(result ??= {}, value);
				else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
			}
			if (!strict && isPlainObject(data)) merge(result, data);
			return [result];
		});
		Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
			const [result, adapted = data] = Schema.resolve(data, inner, options, true);
			if (preserve) return [callback(result)];
			else return [callback(result), callback(adapted)];
		});
		const formatters = {};
		function defineMethod(name, keys, format) {
			formatters[name] = format;
			Object.assign(Schema, { [name](...args) {
				const schema = new Schema({ type: name });
				keys.forEach((key, index) => {
					switch (key) {
						case "sKey":
							schema.sKey = args[index] ?? Schema.string();
							break;
						case "inner":
							schema.inner = Schema.from(args[index]);
							break;
						case "list":
							schema.list = args[index].map(Schema.from);
							break;
						case "dict":
							schema.dict = mapValues(args[index], Schema.from);
							break;
						case "bits":
							schema.bits = {};
							for (const key in args[index]) {
								if (typeof args[index][key] !== "number") continue;
								schema.bits[key] = args[index][key];
							}
							break;
						case "callback": {
							const callback = schema.callback = args[index];
							callback["toJSON"] ||= () => callback.toString();
							break;
						}
						case "constructor": {
							const constructor = schema.constructor = args[index];
							if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
							break;
						}
						default: schema[key] = args[index];
					}
				});
				if (name === "object" || name === "dict") schema.meta.default = {};
				else if (name === "array" || name === "tuple") schema.meta.default = [];
				else if (name === "bitset") schema.meta.default = 0;
				return schema;
			} });
		}
		defineMethod("is", ["constructor"], ({ constructor }) => {
			if (typeof constructor === "function") return constructor.name;
			else return constructor;
		});
		defineMethod("any", [], () => "any");
		defineMethod("never", [], () => "never");
		defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
		defineMethod("string", [], () => "string");
		defineMethod("number", [], () => "number");
		defineMethod("boolean", [], () => "boolean");
		defineMethod("bitset", ["bits"], () => "bitset");
		defineMethod("function", [], () => "function");
		defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
		defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
		defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
		defineMethod("object", ["dict"], ({ dict }) => {
			if (Object.keys(dict).length === 0) return "{}";
			return `{ ${Object.entries(dict).map(([key, inner]) => {
				return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
			}).join(", ")} }`;
		});
		defineMethod("union", ["list"], ({ list }, inline) => {
			const result = list.map(({ toString: format }) => format()).join(" | ");
			return inline ? `(${result})` : result;
		});
		defineMethod("intersect", ["list"], ({ list }) => {
			return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
		});
		defineMethod("transform", [
			"inner",
			"callback",
			"preserve"
		], ({ inner }, isInner) => inner.toString(isInner));
		//#endregion
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
		/** Every field of the section, in the order a reader meets them. */
		const DRAMA_SETTINGS_FIELDS = [
			"deliveryDir",
			"jianyingDraftDir",
			DELIVERY_SPEC_FIELD,
			"bgmDir",
			"imageStandardId",
			"seriesBudgetCents"
		];
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
		Schema.object({
			deliveryDir: Schema.string().default(DRAMA_SETTINGS_DEFAULTS.deliveryDir),
			jianyingDraftDir: Schema.string().default(""),
			[DELIVERY_SPEC_FIELD]: Schema.object({
				width: Schema.number().step(1).min(1).default(DEFAULT_DELIVERY_SPEC.width),
				height: Schema.number().step(1).min(1).default(DEFAULT_DELIVERY_SPEC.height),
				fps: Schema.number().step(1).min(1).max(240).default(DEFAULT_DELIVERY_SPEC.fps),
				minBitrateMbps: Schema.number().min(.1).default(DEFAULT_DELIVERY_SPEC.minBitrateMbps)
			}),
			bgmDir: Schema.string().default(""),
			imageStandardId: Schema.number().step(1).min(1),
			seriesBudgetCents: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DRAMA_SETTINGS_DEFAULTS.seriesBudgetCents)
		});
		//#endregion
		//#region lib/types/client/components.js
		/**
		* The packages the short-drama pipeline is composed from, and the fold that
		* turns one read-only plugin-inventory answer into what the page shows for each.
		*
		* The composition list is a static fact: which packages a short-drama session is
		* built from, in pipeline order, including the BGM mood matcher, which is an
		* independent plugin rather than part of the drama packages. The status is the
		* only runtime fact here, and it comes from the read-only `pluginInventory`
		* namespace — a deployment that composes no inventory yields
		* {@link UNQUERIED}, which the page renders as "could not be queried" instead of
		* as a package that is loaded.
		*/
		/** The composition, in pipeline order. */
		const DRAMA_COMPONENTS = [
			{
				pkg: "@deepseek-ai/dsh-guard-drama",
				role: "component.guard.role"
			},
			{
				pkg: "@deepseek-ai/dsh-tool-drama-assets",
				role: "component.assets.role"
			},
			{
				pkg: "@deepseek-ai/dsh-tool-shot-script",
				role: "component.shot.role"
			},
			{
				pkg: "@deepseek-ai/dsh-perception-bgm",
				role: "component.bgm.role"
			},
			{
				pkg: "@deepseek-ai/dsh-tool-bgm-compose",
				role: "component.bgmCompose.role"
			},
			{
				pkg: "@deepseek-ai/dsh-tool-episode-render",
				role: "component.render.role"
			}
		];
		/**
		* Fold one row into the status the page shows.
		*
		* A disabled row is inactive whatever its fiber says, and a conditional row
		* stays conditional: the Loader decides that condition, so this page cannot
		* report it as either loaded or absent.
		* @param row - one preset or Loader row.
		* @returns the status for that row.
		*/
		function statusOf(row) {
			if (row.enabled === false) return "inactive";
			if (row.enabled === "conditional") return "conditional";
			switch (row.fiberPhase) {
				case "active": return "loaded";
				case "pending":
				case "loading": return "starting";
				case "failed": return "failed";
				case "unloading":
				case null: return "inactive";
			}
		}
		/**
		* The state of every composed component.
		*
		* Preset rows win over Loader entries: a short-drama session is composed by the
		* preset, and its row is what decides whether that session gets the package. An
		* absent snapshot means no inventory was read, which is not the same as an
		* inventory that answered without naming a package.
		* @param snapshot - the last inventory answer, or undefined when none was read.
		* @returns one entry per composed package, in composition order.
		*/
		function componentStates(snapshot) {
			const rows = /* @__PURE__ */ new Map();
			for (const preset of snapshot?.agentPresets ?? []) for (const row of preset.rows) if (!rows.has(row.moduleName)) rows.set(row.moduleName, row);
			for (const entry of snapshot?.entries ?? []) if (!rows.has(entry.moduleName)) rows.set(entry.moduleName, entry);
			return DRAMA_COMPONENTS.map((component) => {
				const row = rows.get(component.pkg);
				if (row === void 0) return {
					component,
					status: snapshot === void 0 ? "unknown" : "absent"
				};
				return {
					component,
					status: statusOf(row),
					...row.condition === void 0 ? {} : { condition: row.condition }
				};
			});
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** Copy dictionaries for the short-drama Settings page. */
		/**
		* Simplified Chinese dictionary and key source of truth.
		*
		* Machine paths are not translated: the draft-root placeholder tells the
		* operator to select the editor's real root without assuming a user's path.
		*/
		const zh = {
			"nav": "短剧",
			"loading": "正在读取短剧设置…",
			"unavailable": "当前部署没有注册短剧设置，这里暂不可用。",
			"readOnly": "当前部署的设置文档只读，无法在这里保存。",
			"deliveryDirTitle": "成片交付目录",
			"deliveryDirDescription": "留空表示用项目自己的 <项目>/delivery（00成片、01主角、02海报、05剧本&简介都在它下面）。",
			"deliveryDirPlaceholder": "留空 = <项目>/delivery",
			"jianyingDraftDirTitle": "剪映草稿根目录",
			"jianyingDraftDirDescription": "请填写剪映专业版中设置的真实草稿根目录；留空表示未配置，不会自动发现。",
			"jianyingDraftDirPlaceholder": "填写剪映专业版的草稿根目录",
			"specTitle": "交付规格",
			"specDescription": "成片的分辨率、帧率与最低码率；渲染与验收都按这四个数执行。",
			"specWidth": "宽度",
			"specHeight": "高度",
			"specFps": "帧率",
			"specBitrate": "最低码率（Mbps）",
			"bgmDirTitle": "BGM 库目录",
			"bgmDirDescription": "本地 BGM 库，选曲按情绪从这里检索；留空表示用默认库，占位符就是它。",
			"seriesBudgetTitle": "每部剧自动收费预算（元）",
			"seriesBudgetDescription": "每部剧/剧变 script_id 自动允许收费直到累计 ¥{amount} 上限；各剧单独计算；这是本机可编辑预算，不是不可篡改的人类批准。无报价或认可估算的收费操作仍会被拒绝。填 0 禁止收费调用；保存时只接受非负金额，最多两位小数。",
			"imageRouteTitle": "资产图生成通道",
			"imageRouteDescription": "账户目录里的 gpt-image-2 按平台分行、各自定价；没选定时只有目录里恰好一行才自动使用，多行会在发起请求前报错。",
			"imageRouteUnset": "不指定（目录只有一行时自动使用）",
			"imageRouteOption": "{platform} · {price} · #{id}",
			"imageRoutePriceUnknown": "价格未知",
			"imageRouteMissing": "#{id}（当前目录里没有这一行）",
			"imageRouteLoading": "正在读取账户目录…",
			"imageRouteUnavailable": "这个部署没有组合剧变生图读取，暂时列不出通道；已保存的选择不受影响。",
			"imageRouteFailed": "读取账户目录失败：{reason}",
			"imageRouteEmpty": "账户目录里没有 gpt-image-2 行。",
			"componentsTitle": "组件状态",
			"componentsDescription": "短剧制作由下面这几个包组成。状态读自只读的插件清单，本页不改变加载状态。",
			"componentsLoading": "正在读取插件清单…",
			"componentsUnqueried": "这个部署没有组合插件清单，无法查询运行态；这些包随 short-drama preset 或宿主 cordis patch 加载。",
			"componentsCondition": "条件：{condition}",
			"component.guard.role": "工具分发门禁：在调用发出的地方执行流水线的硬规则",
			"component.assets.role": "资产对账：生图前把远端已选用资产与本地清单逐条比一遍",
			"component.shot.role": "镜头脚本门禁与单集编译（drama_shot）",
			"component.bgm.role": "BGM 情绪识别：独立插件，工具 bgm_match，不属于短剧包",
			"component.bgmCompose.role": "按剧情计划合成并核验整集 BGM 底轨（drama_bgm）",
			"component.render.role": "成片渲染与交付检查（drama_render）",
			"componentStatus.loaded": "已加载",
			"componentStatus.starting": "启动中",
			"componentStatus.failed": "加载失败",
			"componentStatus.conditional": "按条件加载",
			"componentStatus.inactive": "未加载",
			"componentStatus.absent": "清单里没有",
			"componentStatus.unknown": "无法查询",
			"save": "保存",
			"saving": "正在保存…",
			"saved": "已保存。",
			"reset": "恢复默认",
			"resetting": "正在恢复…",
			"resetDone": "已恢复默认。",
			"rejected": "保存失败：宿主没有接受这次写入。",
			"invalidNumber": "交付规格、资产图通道或每部剧预算无效；预算不得留空，须为最多两位小数的非负金额，请改好再保存。"
		};
		/** English dictionary checked complete against the Chinese key set. */
		const en = {
			"nav": "Short drama",
			"loading": "Reading the short-drama settings…",
			"unavailable": "This deployment registers no short-drama settings, so this page is unavailable.",
			"readOnly": "This deployment stores settings read-only; nothing can be saved here.",
			"deliveryDirTitle": "Delivery directory",
			"deliveryDirDescription": "Leave it blank to use the project’s own <project>/delivery, which holds 00成片, 01主角, 02海报 and 05剧本&简介.",
			"deliveryDirPlaceholder": "blank = <project>/delivery",
			"jianyingDraftDirTitle": "JianyingPro draft root",
			"jianyingDraftDirDescription": "Enter the actual draft root configured in JianyingPro; blank means not configured and is not automatically detected.",
			"jianyingDraftDirPlaceholder": "Enter the JianyingPro draft root",
			"specTitle": "Delivery spec",
			"specDescription": "Resolution, frame rate and bitrate floor of a delivered episode; rendering and acceptance both follow these four numbers.",
			"specWidth": "Width",
			"specHeight": "Height",
			"specFps": "Frame rate",
			"specBitrate": "Bitrate floor (Mbps)",
			"bgmDirTitle": "BGM library",
			"bgmDirDescription": "Local BGM library the mood matcher searches; leave it blank to use the default one — the placeholder is it.",
			"seriesBudgetTitle": "Automatic budget per drama (CNY)",
			"seriesBudgetDescription": "Paid calls are automatically allowed up to a cumulative ¥{amount} per drama/Jubian script_id; each drama is counted separately. This is a locally editable budget, not tamper-proof human approval. Paid calls without a usable quote or accepted estimate are still refused. Enter 0 to disable paid calls; only nonnegative amounts with at most two decimal places can be saved.",
			"imageRouteTitle": "Asset-image route",
			"imageRouteDescription": "The account catalogue lists gpt-image-2 once per platform at its own price. With no row chosen, only a catalogue holding exactly one row works; several rows fail before any request is sent.",
			"imageRouteUnset": "No row pinned (the catalogue decides while it lists one)",
			"imageRouteOption": "{platform} · {price} · #{id}",
			"imageRoutePriceUnknown": "price unknown",
			"imageRouteMissing": "#{id} (not in the current catalogue)",
			"imageRouteLoading": "Reading the account catalogue…",
			"imageRouteUnavailable": "This deployment composes no Jubian image-route reader, so the rows cannot be listed; the saved choice is unaffected.",
			"imageRouteFailed": "Could not read the account catalogue: {reason}",
			"imageRouteEmpty": "The account catalogue lists no gpt-image-2 row.",
			"componentsTitle": "Component status",
			"componentsDescription": "These packages make up a short-drama production. The status is read from the read-only plugin inventory; this page never changes what is loaded.",
			"componentsLoading": "Reading the plugin inventory…",
			"componentsUnqueried": "This deployment composes no plugin inventory, so the run state cannot be queried; these packages load with the short-drama preset or the host cordis patch.",
			"componentsCondition": "Condition: {condition}",
			"component.guard.role": "Tool-dispatch gate: enforces the pipeline’s hard rules where the call is made",
			"component.assets.role": "Asset reconciliation: compares the remote’s already-selected assets with the local manifest before any image is generated",
			"component.shot.role": "Shot-script gate and single-episode compiler (drama_shot)",
			"component.bgm.role": "BGM mood recognition: an independent plugin exposing bgm_match, not part of the drama packages",
			"component.bgmCompose.role": "Episode BGM composition and verification from an explicit story plan (drama_bgm)",
			"component.render.role": "Episode rendering and delivery checks (drama_render)",
			"componentStatus.loaded": "Loaded",
			"componentStatus.starting": "Starting",
			"componentStatus.failed": "Failed",
			"componentStatus.conditional": "Conditional",
			"componentStatus.inactive": "Not loaded",
			"componentStatus.absent": "Not in the inventory",
			"componentStatus.unknown": "Unqueryable",
			"save": "Save",
			"saving": "Saving…",
			"saved": "Saved.",
			"reset": "Restore defaults",
			"resetting": "Restoring…",
			"resetDone": "Defaults restored.",
			"rejected": "Could not save: the host refused this write.",
			"invalidNumber": "A delivery-spec field, asset-image route or per-drama budget is invalid. The budget must be nonblank, nonnegative and have at most two decimal places; fix it before saving."
		};
		/** The label key of one component status. */
		const STATUS_COPY = {
			loaded: "componentStatus.loaded",
			starting: "componentStatus.starting",
			failed: "componentStatus.failed",
			conditional: "componentStatus.conditional",
			inactive: "componentStatus.inactive",
			absent: "componentStatus.absent",
			unknown: "componentStatus.unknown"
		};
		//#endregion
		//#region lib/types/client/section.js
		/**
		* The page's editable draft, the write set it compiles to, and the verdict a
		* write settles with.
		*
		* A draft holds the delivery spec and yuan budget as typed text, because a form
		* field that is briefly not a number is a normal state and typing it must not
		* write anything. {@link draftSection} is the one place that decides what a
		* draft means: a blank path field means "the schema default" — the same value
		* {@link sectionOps} leaves behind by clearing the field rather than storing a
		* copy of it. A blank image-route select means "no row pinned", which is a
		* different value from a row whose id happens to read as blank.
		*/
		/**
		* The draft showing one resolved section.
		* @param settings - the section the page is editing.
		* @returns the same values as editable text.
		*/
		function draftOf(settings) {
			return {
				deliveryDir: settings.deliveryDir,
				jianyingDraftDir: settings.jianyingDraftDir,
				width: String(settings.deliverySpec.width),
				height: String(settings.deliverySpec.height),
				fps: String(settings.deliverySpec.fps),
				minBitrateMbps: String(settings.deliverySpec.minBitrateMbps),
				bgmDir: settings.bgmDir,
				imageStandardId: settings.imageStandardId === void 0 ? "" : String(settings.imageStandardId),
				seriesBudgetYuan: `${Math.trunc(settings.seriesBudgetCents / 100)}${settings.seriesBudgetCents % 100 === 0 ? "" : `.${String(settings.seriesBudgetCents % 100).padStart(2, "0").replace(/0$/, "")}`}`
			};
		}
		/** Parse one number box; undefined while it holds no finite number. */
		function parseNumber(text) {
			const value = Number(text.trim());
			return text.trim().length > 0 && Number.isFinite(value) ? value : void 0;
		}
		/** Convert yuan text to safe integer cents without a floating-point decimal conversion. */
		function parseBudget(text) {
			const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
			if (match === null) return void 0;
			const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
			return Number.isSafeInteger(cents) ? cents : void 0;
		}
		/** One path box, or its default while the box is blank. */
		function parsePath(text, fallback) {
			const trimmed = text.trim();
			return trimmed.length === 0 ? fallback : trimmed;
		}
		/**
		* The section one draft asks for.
		* @param draft - the current form values.
		* @returns the section to persist, or undefined while a spec box, image-route
		*   select or yuan budget holds an invalid value.
		*/
		function draftSection(draft) {
			const width = parseNumber(draft.width);
			const height = parseNumber(draft.height);
			const fps = parseNumber(draft.fps);
			const minBitrateMbps = parseNumber(draft.minBitrateMbps);
			const seriesBudgetCents = parseBudget(draft.seriesBudgetYuan);
			if (width === void 0 || height === void 0 || fps === void 0 || minBitrateMbps === void 0 || seriesBudgetCents === void 0) return;
			const unpinned = draft.imageStandardId.trim().length === 0;
			const imageStandardId = parseNumber(draft.imageStandardId);
			if (!unpinned && imageStandardId === void 0) return void 0;
			const section = {
				deliveryDir: parsePath(draft.deliveryDir, DRAMA_SETTINGS_DEFAULTS.deliveryDir),
				jianyingDraftDir: parsePath(draft.jianyingDraftDir, DRAMA_SETTINGS_DEFAULTS.jianyingDraftDir),
				deliverySpec: {
					width,
					height,
					fps,
					minBitrateMbps
				},
				bgmDir: parsePath(draft.bgmDir, DRAMA_SETTINGS_DEFAULTS.bgmDir),
				seriesBudgetCents
			};
			return imageStandardId === void 0 ? section : {
				...section,
				imageStandardId
			};
		}
		/** Whether two specs state the same four numbers. */
		function sameSpec(left, right) {
			return left.width === right.width && left.height === right.height && left.fps === right.fps && left.minBitrateMbps === right.minBitrateMbps;
		}
		/**
		* Whether a resolved section is exactly the intended one — the evidence that a
		* write landed, read from the same snapshot the page renders.
		* @param current - the section the settings namespace resolves to now.
		* @param intended - the section the page asked for.
		* @returns true when every field already states the intended value.
		*/
		function sameSettings(current, intended) {
			return current.deliveryDir === intended.deliveryDir && current.jianyingDraftDir === intended.jianyingDraftDir && current.bgmDir === intended.bgmDir && current.seriesBudgetCents === intended.seriesBudgetCents && current.imageStandardId === intended.imageStandardId && sameSpec(current.deliverySpec, intended.deliverySpec);
		}
		/**
		* Whether a namespace holds the intended section.
		* @param current - the section the namespace resolves to, absent before its first read.
		* @param intended - the section a write asked for.
		* @returns true only when a resolved section states the intended value.
		*/
		function landed(current, intended) {
			return current !== void 0 && sameSettings(current, intended);
		}
		/**
		* The write set taking one resolved section to the intended one.
		*
		* A field already stating the intended value is untouched, and a field whose
		* intended value IS the schema default — or is absent, which states the same
		* thing — is cleared: the user layer then holds no override that says nothing,
		* which is also what "restore defaults" leaves behind. The spec is compared
		* field by field because it is the one object-valued setting. A namespace that
		* has not resolved yet holds no user layer, so it compares as the defaults.
		* @param current - the resolved section, or undefined before the first read.
		* @param intended - the section the page asks for.
		* @returns ordered path operations for one atomic namespace write.
		*/
		function sectionOps(current, intended) {
			const from = current ?? DRAMA_SETTINGS_DEFAULTS;
			const ops = [];
			const scalar = (field) => {
				const value = intended[field];
				if (value === from[field]) return;
				ops.push(value === void 0 || value === DRAMA_SETTINGS_DEFAULTS[field] ? {
					op: "unset",
					path: [field]
				} : {
					op: "set",
					path: [field],
					value
				});
			};
			scalar("deliveryDir");
			scalar("jianyingDraftDir");
			scalar("bgmDir");
			scalar("imageStandardId");
			scalar("seriesBudgetCents");
			if (!sameSpec(intended.deliverySpec, from.deliverySpec)) ops.push(sameSpec(intended.deliverySpec, DRAMA_SETTINGS_DEFAULTS.deliverySpec) ? {
				op: "unset",
				path: [DELIVERY_SPEC_FIELD]
			} : {
				op: "set",
				path: [DELIVERY_SPEC_FIELD],
				value: intended.deliverySpec
			});
			return ops;
		}
		/**
		* Clear every field, which is what returns the section to its schema defaults.
		* @returns one unset operation per field, for a single atomic namespace write.
		*/
		function defaultOps() {
			return DRAMA_SETTINGS_FIELDS.map((field) => ({
				op: "unset",
				path: [field]
			}));
		}
		//#endregion
		//#region \0dsh-css:E:\deepseek-harness\packages\drama\drama-settings\src\client\DramaSettingsSection.module.css.mjs
		const css = ".wWGKya_section{width:100%;color:var(--dsw-alias-label-primary);flex-direction:column;gap:20px;display:flex}.wWGKya_group{flex-direction:column;gap:6px;display:flex}.wWGKya_groupTitle{margin:0;font-size:14px;font-weight:600;line-height:22px}.wWGKya_groupDescription{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}.wWGKya_budgetWarning{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:8px;margin:0;padding:10px 12px;font-size:13px;line-height:20px}.wWGKya_spec{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px 12px;margin-top:4px;display:grid}.wWGKya_specField{flex-direction:column;gap:6px;display:flex}.wWGKya_specLabel{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}.wWGKya_input{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);width:100%;height:32px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:0 12px}.wWGKya_actions{align-items:center;gap:8px;display:flex}.wWGKya_notice{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}.wWGKya_components{flex-direction:column;gap:10px;margin:4px 0 0;padding:0;list-style:none;display:flex}.wWGKya_component{grid-template-columns:auto 1fr;align-items:start;gap:8px;display:grid}.wWGKya_componentState{min-width:96px;color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;line-height:18px;display:inline-flex}.wWGKya_componentStatus{white-space:nowrap}.wWGKya_componentText{flex-direction:column;gap:2px;min-width:0;display:flex}.wWGKya_componentRole{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}.wWGKya_componentPkg{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px;line-height:18px}.wWGKya_componentCondition{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}";
		const tagId = "@deepseek-ai/dsh-drama-settings/DramaSettingsSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-drama-settings";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var DramaSettingsSection_module_css_default = {
			"actions": "wWGKya_actions",
			"budgetWarning": "wWGKya_budgetWarning",
			"component": "wWGKya_component",
			"componentCondition": "wWGKya_componentCondition",
			"componentPkg": "wWGKya_componentPkg",
			"componentRole": "wWGKya_componentRole",
			"componentState": "wWGKya_componentState",
			"componentStatus": "wWGKya_componentStatus",
			"componentText": "wWGKya_componentText",
			"components": "wWGKya_components",
			"group": "wWGKya_group",
			"groupDescription": "wWGKya_groupDescription",
			"groupTitle": "wWGKya_groupTitle",
			"input": "wWGKya_input",
			"notice": "wWGKya_notice",
			"section": "wWGKya_section",
			"spec": "wWGKya_spec",
			"specField": "wWGKya_specField",
			"specLabel": "wWGKya_specLabel"
		};
		//#endregion
		//#region lib/types/client/DramaSettingsSection.js
		/**
		* The short-drama Settings page, browser half.
		*
		* One form over the `drama` settings section — the two directories, the delivery
		* spec's four numbers, the BGM library, the paid image route's catalogue row and
		* the per-drama paid-call budget —
		* plus the read-only component list that says which packages a short-drama
		* production is built from and what the plugin inventory reports about each.
		*
		* The form follows the resolved section rather than its own echo: after each
		* commit it adopts the values the Host reports, and a write that did not land is
		* reported as a failure instead of being shown as saved. The component list is
		* read once per mount and never claims a package is loaded that no inventory
		* named. Paid calls within the editable budget need no per-call confirmation.
		*/
		/** Which status dot a component status shows; only `loaded` reads as green. */
		const STATUS_DOT = {
			loaded: "done",
			starting: "ongoing",
			failed: "error",
			conditional: "warning",
			inactive: "idle",
			absent: "idle",
			unknown: "idle"
		};
		/** The read-only component list: one row per composed package. */
		function ComponentList({ components, t }) {
			return (0, react_jsx_runtime.jsxs)("section", {
				className: DramaSettingsSection_module_css_default.group,
				children: [
					(0, react_jsx_runtime.jsx)("h3", {
						className: DramaSettingsSection_module_css_default.groupTitle,
						children: t("componentsTitle")
					}),
					(0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.groupDescription,
						children: t("componentsDescription")
					}),
					components === void 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						"aria-busy": "true",
						children: t("componentsLoading")
					}) : (0, react_jsx_runtime.jsx)("ul", {
						className: DramaSettingsSection_module_css_default.components,
						children: components.map(({ component, status, condition }) => (0, react_jsx_runtime.jsxs)("li", {
							className: DramaSettingsSection_module_css_default.component,
							children: [(0, react_jsx_runtime.jsxs)("span", {
								className: DramaSettingsSection_module_css_default.componentState,
								children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: STATUS_DOT[status] }), (0, react_jsx_runtime.jsx)("span", {
									className: DramaSettingsSection_module_css_default.componentStatus,
									children: t(STATUS_COPY[status])
								})]
							}), (0, react_jsx_runtime.jsxs)("span", {
								className: DramaSettingsSection_module_css_default.componentText,
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: DramaSettingsSection_module_css_default.componentRole,
										children: t(component.role)
									}),
									(0, react_jsx_runtime.jsx)("code", {
										className: DramaSettingsSection_module_css_default.componentPkg,
										children: component.pkg
									}),
									condition === void 0 ? null : (0, react_jsx_runtime.jsx)("span", {
										className: DramaSettingsSection_module_css_default.componentCondition,
										children: t("componentsCondition", { condition })
									})
								]
							})]
						}, component.pkg))
					}),
					components !== void 0 && components.every((entry) => entry.status === "unknown") ? (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						children: t("componentsUnqueried")
					}) : null
				]
			});
		}
		/**
		* The one-line label of a payable row: the platform, the row's own price, and
		* the id that pins it.
		* @param route - one row of the account catalogue.
		* @param t - the page's bound copy.
		* @returns the option text.
		*/
		function routeLabel(route, t) {
			const price = route.unitPrice === null || route.unit === null ? t("imageRoutePriceUnknown") : `${String(route.unitPrice)} ${route.unit}`;
			return t("imageRouteOption", {
				platform: route.platformId,
				price,
				id: String(route.standardId)
			});
		}
		/**
		* The paid image route's row picker.
		*
		* The section's own value is what the select shows even when the catalogue read
		* failed or no longer lists that row: a list this page could not read is not
		* permission to drop a choice somebody already made.
		* @param props - the current draft, the last catalogue answer, the copy and the change sink.
		* @returns the group element tree.
		*/
		function ImageRouteGroup({ draft, routes, t, onChange }) {
			const listed = routes?.status === "ok" ? routes.routes : [];
			const pinned = draft.imageStandardId;
			const delisted = pinned !== "" && !listed.some((route) => String(route.standardId) === pinned);
			return (0, react_jsx_runtime.jsxs)("section", {
				className: DramaSettingsSection_module_css_default.group,
				children: [
					(0, react_jsx_runtime.jsx)("h3", {
						className: DramaSettingsSection_module_css_default.groupTitle,
						children: t("imageRouteTitle")
					}),
					(0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.groupDescription,
						children: t("imageRouteDescription")
					}),
					(0, react_jsx_runtime.jsxs)("select", {
						className: DramaSettingsSection_module_css_default.input,
						value: pinned,
						"aria-label": t("imageRouteTitle"),
						onChange: (event) => {
							onChange(event.currentTarget.value);
						},
						children: [
							(0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: t("imageRouteUnset")
							}),
							delisted ? (0, react_jsx_runtime.jsx)("option", {
								value: pinned,
								children: t("imageRouteMissing", { id: pinned })
							}) : null,
							listed.map((route) => (0, react_jsx_runtime.jsx)("option", {
								value: String(route.standardId),
								children: routeLabel(route, t)
							}, route.standardId))
						]
					}),
					routes === void 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						"aria-busy": "true",
						children: t("imageRouteLoading")
					}) : null,
					routes?.status === "unavailable" ? (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						children: t("imageRouteUnavailable")
					}) : null,
					routes?.status === "failed" ? (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						role: "status",
						children: t("imageRouteFailed", { reason: routes.message })
					}) : null,
					routes?.status === "ok" && routes.routes.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						children: t("imageRouteEmpty")
					}) : null
				]
			});
		}
		/**
		* Render the short-drama settings page.
		* @param props - composed slot props (see {@link DramaSettingsSectionProps}).
		* @returns the settings page element tree.
		*/
		function DramaSettingsSection(props) {
			const { t, useDrama, write, restoreDefaults, components, imageRoutes } = props;
			const snapshot = useDrama((value) => value);
			const settings = snapshot.value;
			const [draft, setDraft] = (0, react.useState)(void 0);
			const [states, setStates] = (0, react.useState)(void 0);
			const [routes, setRoutes] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				setDraft(settings === void 0 ? void 0 : draftOf(settings));
			}, [settings]);
			(0, react.useEffect)(() => {
				let current = true;
				components().then((next) => {
					if (current) setStates(next);
				});
				return () => {
					current = false;
				};
			}, [components]);
			(0, react.useEffect)(() => {
				let current = true;
				imageRoutes().then((next) => {
					if (current) setRoutes(next);
				});
				return () => {
					current = false;
				};
			}, [imageRoutes]);
			const componentList = (0, react_jsx_runtime.jsx)(ComponentList, {
				components: states,
				t
			});
			if (snapshot.status === "unavailable") return (0, react_jsx_runtime.jsxs)("div", {
				className: DramaSettingsSection_module_css_default.section,
				children: [(0, react_jsx_runtime.jsx)("p", {
					className: DramaSettingsSection_module_css_default.notice,
					children: t("unavailable")
				}), componentList]
			});
			if (draft === void 0 || settings === void 0) return (0, react_jsx_runtime.jsxs)("div", {
				className: DramaSettingsSection_module_css_default.section,
				children: [(0, react_jsx_runtime.jsx)("p", {
					className: DramaSettingsSection_module_css_default.notice,
					"aria-busy": "true",
					children: t("loading")
				}), componentList]
			});
			const intended = draftSection(draft);
			const dirty = intended === void 0 || !sameSettings(settings, intended);
			/**
			* Run one write, then report what it did. A refusal shows the failure line and
			* leaves the draft alone, so the same page can be corrected and retried.
			* @param call - the write to run.
			* @param done - the notice a landed write shows.
			*/
			const run = (call, done) => {
				setBusy(true);
				setNotice(void 0);
				call().then((outcome) => {
					setBusy(false);
					setNotice(outcome === "saved" ? done : outcome === "invalid" ? t("invalidNumber") : t("rejected"));
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: DramaSettingsSection_module_css_default.section,
				children: [
					(0, react_jsx_runtime.jsxs)("section", {
						className: DramaSettingsSection_module_css_default.group,
						children: [
							(0, react_jsx_runtime.jsx)("h3", {
								className: DramaSettingsSection_module_css_default.groupTitle,
								children: t("seriesBudgetTitle")
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: DramaSettingsSection_module_css_default.budgetWarning,
								children: t("seriesBudgetDescription", { amount: draftOf(settings).seriesBudgetYuan })
							}),
							(0, react_jsx_runtime.jsx)("input", {
								className: DramaSettingsSection_module_css_default.input,
								type: "text",
								inputMode: "decimal",
								value: draft.seriesBudgetYuan,
								"aria-label": t("seriesBudgetTitle"),
								onChange: (event) => {
									setDraft({
										...draft,
										seriesBudgetYuan: event.currentTarget.value
									});
								}
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: DramaSettingsSection_module_css_default.group,
						children: [
							(0, react_jsx_runtime.jsx)("h3", {
								className: DramaSettingsSection_module_css_default.groupTitle,
								children: t("deliveryDirTitle")
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: DramaSettingsSection_module_css_default.groupDescription,
								children: t("deliveryDirDescription")
							}),
							(0, react_jsx_runtime.jsx)("input", {
								className: DramaSettingsSection_module_css_default.input,
								value: draft.deliveryDir,
								spellCheck: false,
								placeholder: t("deliveryDirPlaceholder"),
								"aria-label": t("deliveryDirTitle"),
								onChange: (event) => {
									setDraft({
										...draft,
										deliveryDir: event.currentTarget.value
									});
								}
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: DramaSettingsSection_module_css_default.group,
						children: [
							(0, react_jsx_runtime.jsx)("h3", {
								className: DramaSettingsSection_module_css_default.groupTitle,
								children: t("jianyingDraftDirTitle")
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: DramaSettingsSection_module_css_default.groupDescription,
								children: t("jianyingDraftDirDescription")
							}),
							(0, react_jsx_runtime.jsx)("input", {
								className: DramaSettingsSection_module_css_default.input,
								value: draft.jianyingDraftDir,
								spellCheck: false,
								placeholder: t("jianyingDraftDirPlaceholder"),
								"aria-label": t("jianyingDraftDirTitle"),
								onChange: (event) => {
									setDraft({
										...draft,
										jianyingDraftDir: event.currentTarget.value
									});
								}
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: DramaSettingsSection_module_css_default.group,
						children: [
							(0, react_jsx_runtime.jsx)("h3", {
								className: DramaSettingsSection_module_css_default.groupTitle,
								children: t("specTitle")
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: DramaSettingsSection_module_css_default.groupDescription,
								children: t("specDescription")
							}),
							(0, react_jsx_runtime.jsx)("div", {
								className: DramaSettingsSection_module_css_default.spec,
								children: [
									["width", t("specWidth")],
									["height", t("specHeight")],
									["fps", t("specFps")],
									["minBitrateMbps", t("specBitrate")]
								].map(([field, label]) => (0, react_jsx_runtime.jsxs)("label", {
									className: DramaSettingsSection_module_css_default.specField,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: DramaSettingsSection_module_css_default.specLabel,
										children: label
									}), (0, react_jsx_runtime.jsx)("input", {
										className: DramaSettingsSection_module_css_default.input,
										type: "number",
										inputMode: "decimal",
										value: draft[field],
										"aria-label": label,
										onChange: (event) => {
											setDraft({
												...draft,
												[field]: event.currentTarget.value
											});
										}
									})]
								}, field))
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: DramaSettingsSection_module_css_default.group,
						children: [
							(0, react_jsx_runtime.jsx)("h3", {
								className: DramaSettingsSection_module_css_default.groupTitle,
								children: t("bgmDirTitle")
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: DramaSettingsSection_module_css_default.groupDescription,
								children: t("bgmDirDescription")
							}),
							(0, react_jsx_runtime.jsx)("input", {
								className: DramaSettingsSection_module_css_default.input,
								value: draft.bgmDir,
								spellCheck: false,
								placeholder: DRAMA_SETTINGS_DEFAULTS.bgmDir,
								"aria-label": t("bgmDirTitle"),
								onChange: (event) => {
									setDraft({
										...draft,
										bgmDir: event.currentTarget.value
									});
								}
							})
						]
					}),
					(0, react_jsx_runtime.jsx)(ImageRouteGroup, {
						draft,
						routes,
						t,
						onChange: (imageStandardId) => {
							setDraft({
								...draft,
								imageStandardId
							});
						}
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: DramaSettingsSection_module_css_default.actions,
						children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: busy || !snapshot.writable || !dirty || intended === void 0,
							onClick: () => {
								run(() => write(draft), t("saved"));
							},
							children: busy ? t("saving") : t("save")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							disabled: busy || !snapshot.writable,
							onClick: () => {
								run(restoreDefaults, t("resetDone"));
							},
							children: busy ? t("resetting") : t("reset")
						})]
					}),
					intended === void 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						role: "status",
						children: t("invalidNumber")
					}) : null,
					notice === void 0 ? null : (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						role: "status",
						children: notice
					}),
					snapshot.writable ? null : (0, react_jsx_runtime.jsx)("p", {
						className: DramaSettingsSection_module_css_default.notice,
						children: t("readOnly")
					}),
					componentList
				]
			});
		}
		//#endregion
		//#region lib/types/client/routes.js
		/**
		* The rows the paid asset-image route can buy from, as the 短剧 page reads them.
		*
		* The rows arrive over the `jubianImage` Remote namespace, which
		* `@deepseek-ai/dsh-tool-jubian` owns: that package holds the credential and the
		* transport that read the account catalogue, so this page only ever sees the
		* rows a person may choose between — never the token behind them.
		*
		* The namespace is optional, the way the plugin inventory is: a deployment that
		* composes no Jubian tools answers {@link DramaImageRoutes} with `unavailable`
		* rather than an empty catalogue, which would look like an account with no rows.
		*/
		/**
		* Fold one Remote answer into what the page shows.
		* @param result - the namespace's answer, or its refusal.
		* @returns the rows, or the reason there are none to show.
		*/
		function imageRoutesOf(result) {
			return result.ok ? {
				status: "ok",
				routes: result.value.candidates
			} : {
				status: "failed",
				message: `${result.error.code}: ${result.error.message}`
			};
		}
		//#endregion
		//#region lib/types/client/index.js
		/**
		* Short-drama settings, browser half: the Settings page over the `drama` settings
		* namespace the Host half registers.
		*
		* The page registers through `ctx.slots.inject`, which waits for the slot's own
		* declaration — this package does not own the Settings shell — and it leaves with
		* its fiber when the declarer collapses. The per-drama budget is resolved from
		* the same settings namespace and included in save and restore writes.
		*
		* @module @deepseek-ai/dsh-drama-settings/src/client
		*/
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.drama";
		/** Required services: the slot and locale surfaces plus the settings scope service. */
		const inject = [
			"slots",
			"locale",
			"settingsScope"
		];
		/**
		* Read the composed packages' state from the optional read-only inventory.
		*
		* `remote.pluginInventory` belongs to a deployment that composes the plugin
		* inventory; `ctx.get` is what makes that optional rather than a service this
		* row waits for. With no namespace, or with a failed read, every component is
		* reported unqueryable — the page never infers "loaded" from silence.
		* @param ctx - Client context that may carry the inventory namespace.
		* @returns one state per composed package.
		*/
		async function componentState(ctx) {
			const inventory = ctx.get("remote.pluginInventory");
			if (inventory === void 0) return componentStates(void 0);
			try {
				const result = await inventory.list();
				return componentStates(result.ok ? result.value : void 0);
			} catch {
				return componentStates(void 0);
			}
		}
		/**
		* Read the rows the paid asset-image route can buy from.
		*
		* The namespace is looked up per call rather than captured at registration: it
		* belongs to another bundled plugin, which may mount before or after this page,
		* and a page that resolved it once would answer `unavailable` forever on a
		* deployment that composes both.
		* @param ctx - Client context that may carry the Jubian image-route namespace.
		* @returns the payable rows, or why there are none to show.
		*/
		async function imageRouteState(ctx) {
			const face = ctx.get("remote.jubianImage");
			if (face === void 0) return { status: "unavailable" };
			try {
				return imageRoutesOf(await face.routes());
			} catch (error) {
				return {
					status: "failed",
					message: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/**
		* Mount the Settings page over the namespace scope.
		* @param ctx - Client context carrying the slot registry, locale, and settings scope.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "drama-settings: dictionaries");
			const t = ctx.locale.bind(NS);
			const scope = ctx.settingsScope.bind({ namespace: DRAMA_SETTINGS_NAMESPACE });
			/**
			* Write one section and answer whether it landed.
			*
			* A refusal is not thrown by the settings scope — it recovers the host's
			* current state and settles — so the verdict is read from that state: the
			* snapshot the page renders is also the evidence for what happened.
			* @param ops - the path operations to apply.
			* @param intended - the section those operations ask for.
			* @returns the outcome the page reports.
			*/
			const commit = async (ops, intended) => {
				await scope.mutate(ops);
				return landed(scope.getSnapshot().value, intended) ? "saved" : "rejected";
			};
			const sectionInjected = () => ({
				hooks: { drama: scope },
				write: async (draft) => {
					const intended = draftSection(draft);
					if (intended === void 0) return "invalid";
					return await commit(sectionOps(scope.getSnapshot().value, intended), intended);
				},
				restoreDefaults: async () => await commit(defaultOps(), DRAMA_SETTINGS_DEFAULTS),
				components: async () => await componentState(ctx),
				imageRoutes: async () => await imageRouteState(ctx)
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "drama",
				order: 17,
				label: () => t("nav"),
				locale: NS,
				inject: sectionInjected
			}, DramaSettingsSection));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map