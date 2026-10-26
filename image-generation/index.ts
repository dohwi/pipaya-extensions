// image-generation: adds image-generation models to pipaya. Pick one of its models in a chat: each message is a picture
// request, the reply is the picture. Pictures are saved under .pipaya/generated in the chat's folder, and a follow-up
// without a picture edits the last one. Works with OpenRouter and other chat-completions endpoints with image output.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { lastUser, mimeOfPath, parseModels, parseResponse, picturePath, previousPicturePath, replyText, requestBody, type Picture } from "./lib.ts";

const PROVIDER = "image-generation";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODELS = "google/gemini-3.1-flash-image";
const TIMEOUT_MS = 180_000;

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** The smallest stream the agent loop reads: async iterable events, and `result()` with the final message. */
function eventStream() {
	const queue: any[] = [];
	let wake: (() => void) | null = null;
	let finished = false;
	let resolveResult!: (m: any) => void;
	const result = new Promise<any>((r) => (resolveResult = r));
	return {
		push(event: any) {
			if (finished) return;
			if (event.type === "done") { finished = true; resolveResult(event.message); }
			if (event.type === "error") { finished = true; resolveResult(event.error); }
			queue.push(event);
			wake?.();
		},
		result: () => result,
		async *[Symbol.asyncIterator]() {
			for (;;) {
				if (queue.length) { yield queue.shift(); continue; }
				if (finished) return;
				await new Promise<void>((r) => (wake = r));
				wake = null;
			}
		},
	};
}

/** `path` inside `cwd`, or undefined when it points elsewhere. */
function inside(cwd: string, path: string): string | undefined {
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? abs : undefined;
}

export default (pi: any) => {
	const settings = () => {
		const s = pi.settings.get() as Record<string, unknown>;
		const baseUrl = typeof s.baseUrl === "string" && s.baseUrl.trim() ? s.baseUrl.trim().replace(/\/+$/, "") : DEFAULT_BASE_URL;
		const apiKey = typeof s.apiKey === "string" ? s.apiKey.trim() : "";
		const models = parseModels(s.models ?? DEFAULT_MODELS);
		return { baseUrl, apiKey, models: models.length ? models : parseModels(DEFAULT_MODELS) };
	};

	async function generate(model: any, context: any, options: any, stream: ReturnType<typeof eventStream>) {
		const msg: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
		const fail = (reason: "error" | "aborted", message: string) => {
			msg.stopReason = reason;
			msg.errorMessage = message;
			stream.push({ type: "error", reason, error: msg });
		};
		stream.push({ type: "start", partial: msg });
		try {
			const cwd: string | undefined = options?.sessionId ? pi.sessions.get(options.sessionId)?.cwd : undefined;
			if (!cwd) return fail("error", "the chat has no working directory");
			const { text, images } = lastUser(context.messages);
			if (!text.trim() && !images.length) return fail("error", "write what the picture should show");
			const input: Picture[] = [...images];
			if (!images.length) {
				const prev = previousPicturePath(context.messages);
				const abs = prev ? inside(cwd, prev) : undefined;
				const mimeType = prev ? mimeOfPath(prev) : undefined;
				if (abs && mimeType) {
					try { input.push({ data: (await readFile(abs)).toString("base64"), mimeType }); } catch { /* gone: draw from the words alone */ }
				}
			}
			const { baseUrl, apiKey } = settings();
			const signal = options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
			const res = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${options?.apiKey || apiKey}` },
				body: JSON.stringify(requestBody(model.id, text, input, true)),
				signal,
			});
			if (!res.ok) return fail("error", `image request failed (${res.status})`);
			const out = parseResponse(await res.json());
			if (!out.pictures.length) return fail("error", out.text ? `the model returned no picture: ${out.text.slice(0, 200)}` : "the model returned no picture");
			const paths: string[] = [];
			for (const p of out.pictures) {
				const path = picturePath(p.mimeType);
				const abs = inside(cwd, path)!;
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, Buffer.from(p.data, "base64"));
				paths.push(path);
			}
			if (out.usage) msg.usage = { ...zeroUsage(), input: out.usage.input, output: out.usage.output, totalTokens: out.usage.input + out.usage.output };
			const body = replyText(text, out.text, paths);
			const block = { type: "text", text: "" };
			msg.content = [block];
			stream.push({ type: "text_start", contentIndex: 0, partial: msg });
			block.text = body;
			stream.push({ type: "text_delta", contentIndex: 0, delta: body, partial: msg });
			stream.push({ type: "text_end", contentIndex: 0, content: body, partial: msg });
			stream.push({ type: "done", reason: "stop", message: msg });
		} catch (e) {
			fail(options?.signal?.aborted ? "aborted" : "error", e instanceof Error ? e.message : String(e));
		}
	}

	const provider = () => {
		const { baseUrl, models } = settings();
		const list = models.map((id) => ({
			id, name: id.split("/").pop(), api: "openai-completions", provider: PROVIDER, baseUrl,
			reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 65_536, maxTokens: 32_768,
		}));
		const streamSimple = (model: any, context: any, options: any) => {
			const s = eventStream();
			void generate(model, context, options, s);
			return s;
		};
		return {
			id: PROVIDER,
			name: "Image generation",
			baseUrl,
			// The key from the settings form, or one stored for this provider the usual way.
			auth: { apiKey: { name: "Image generation API key", resolve: async ({ credential }: { credential?: { key?: string } }) => {
				const key = credential?.key || settings().apiKey;
				return key ? { auth: { apiKey: key } } : undefined;
			} } },
			getModels: () => list,
			stream: streamSimple,
			streamSimple,
		};
	};

	pi.registerProvider(provider());
	pi.settings.onChange(() => pi.registerProvider(provider()));
};
