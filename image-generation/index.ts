// image-generation: runs the image models of your connections. pipaya lists a model as an image model (from the
// connection's model list or the "image generation" switch in its settings) but does not run it itself; this extension
// does: each message is a picture request, the reply is the picture. Pictures are saved under .pipaya/generated in the
// chat's folder, and a follow-up without a picture edits the last one. It uses the connection's own address and key.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { lastUser, mimeOfPath, parseResponse, picturePath, previousPicturePath, replyText, requestBody, type Picture } from "./lib.ts";

const TIMEOUT_MS = 180_000;

/** `path` inside `cwd`, or undefined when it points elsewhere. */
function inside(cwd: string, path: string): string | undefined {
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? abs : undefined;
}

export default (pi: any) => {
	pi.registerModelRunner("image", async (req: any) => {
		const { text, images } = lastUser(req.messages);
		if (!text.trim() && !images.length) throw new Error("write what the picture should show");
		const input: Picture[] = [...images];
		if (!images.length) {
			const prev = previousPicturePath(req.messages);
			const abs = prev ? inside(req.cwd, prev) : undefined;
			const mimeType = prev ? mimeOfPath(prev) : undefined;
			if (abs && mimeType) {
				try { input.push({ data: (await readFile(abs)).toString("base64"), mimeType }); } catch { /* gone: draw from the words alone */ }
			}
		}
		const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
		const res = await fetch(`${String(req.model.baseUrl).replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: { ...(req.model.headers ?? {}), "content-type": "application/json", ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}) },
			body: JSON.stringify(requestBody(req.model.id, text, input, true)),
			signal,
		});
		if (!res.ok) throw new Error(`image request failed (${res.status})`);
		const out = parseResponse(await res.json());
		if (!out.pictures.length) throw new Error(out.text ? `the model returned no picture: ${out.text.slice(0, 200)}` : "the model returned no picture");
		const paths: string[] = [];
		for (const p of out.pictures) {
			const path = picturePath(p.mimeType);
			const abs = inside(req.cwd, path)!;
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, Buffer.from(p.data, "base64"));
			paths.push(path);
		}
		return { text: replyText(text, out.text, paths), ...(out.usage ? { usage: out.usage } : {}) };
	});
};
