#!/usr/bin/env bun
// Checks every top-level folder that holds an extension (one folder = one extension): package.json fields, the entry file, and the tests that can run here.
//   bun scripts/check.ts                 every extension
//   bun scripts/check.ts guard      one extension (set PIPAYA_APP=<pipaya>/server to run its server tests too)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIR = ROOT;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const only = process.argv[2];

export type Problem = string;

/** Problems in one extension folder; empty = fine. */
export function checkExtension(id: string, dir = join(DIR, id)): Problem[] {
	const errs: Problem[] = [];
	if (!ID.test(id)) errs.push("folder name must be lowercase letters, digits and dashes");
	let pkg: Record<string, any> = {};
	try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return [...errs, "package.json is missing or not valid JSON"]; }
	for (const k of ["name", "version", "description", "license", "author"]) if (typeof pkg[k] !== "string" || !pkg[k]) errs.push(`package.json: "${k}" is required`);
	if (typeof pkg.version === "string" && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version)) errs.push(`package.json: version "${pkg.version}" is not x.y.z`);
	if (pkg.repository?.directory !== id) errs.push(`package.json: repository.directory must be "${id}"`);
	if (!existsSync(join(dir, "README.md"))) errs.push("README.md is missing");
	const client = existsSync(join(dir, "manifest.json"));
	if (client) {
		const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		if (m.id !== id) errs.push(`manifest.json: id is "${m.id}", expected "${id}"`);
		if (m.version !== pkg.version) errs.push(`manifest.json version ${m.version} differs from package.json ${pkg.version}`);
		if (!existsSync(join(dir, "dist", `${id}.json`))) errs.push(`dist/${id}.json is missing (run the build)`);
	} else if (!["index.ts", "index.js"].some((f) => existsSync(join(dir, f)))) errs.push("no index.ts or index.js");
	// A server extension that carries its client half (`pipaya.client`) must carry the current build of `pipaya.companion`.
	const meta = pkg.pipaya ?? {};
	if (meta.client !== undefined) {
		if (typeof meta.companion !== "string") errs.push("package.json: pipaya.client needs pipaya.companion");
		else if (typeof meta.client !== "string" || !/^(?!.*\.\.)[\w./-]+\.json$/.test(meta.client) || !existsSync(join(dir, meta.client))) errs.push(`package.json: pipaya.client "${meta.client}" is not a .json file in the folder`);
		else {
			const built = join(ROOT, meta.companion, "dist", `${meta.companion}.json`);
			if (existsSync(built) && readFileSync(built, "utf8") !== readFileSync(join(dir, meta.client), "utf8")) errs.push(`${meta.client} differs from ${meta.companion}/dist/${meta.companion}.json (build ${meta.companion})`);
			if (JSON.parse(readFileSync(join(dir, meta.client), "utf8"))?.manifest?.id !== meta.companion) errs.push(`${meta.client}: manifest.id is not "${meta.companion}"`);
		}
	}
	// `pipaya.settings` is drawn by the client's settings form, which validates it like a client manifest's `settings`
	// (app: client/src/lib/extensions/schema.ts). One bad field hides the whole form behind a single warning, so the
	// mistakes that do that are caught here.
	if (meta.settings !== undefined) {
		if (!Array.isArray(meta.settings)) errs.push("package.json: pipaya.settings must be an array");
		else meta.settings.forEach((f: any, i: number) => {
			const at = `pipaya.settings[${i}]`;
			if (!f || typeof f !== "object" || Array.isArray(f)) { errs.push(`${at}: expected an object`); return; }
			if (typeof f.key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(f.key)) errs.push(`${at}.key: expected a letter followed by letters, digits or underscores`);
			if (!["string", "number", "boolean", "select"].includes(f.type)) errs.push(`${at}.type: expected string, number, boolean or select`);
			if (typeof f.label !== "string" || !f.label.trim()) errs.push(`${at}.label: expected a non-empty string`);
			if ("readonly" in f && typeof f.readonly !== "boolean") errs.push(`${at}.readonly: expected a boolean`);
			if (f.readonly === true && f.secret === true) errs.push(`${at}.readonly: a secret field cannot be read-only`);
			// `when` must name an earlier field: a typo or a later key hides the field for good (app 0.8.6+ checks the same).
			if ("when" in f) {
				const earlier = meta.settings.slice(0, i).find((g: any) => g?.key === f.when?.key);
				if (!f.when || typeof f.when !== "object" || !earlier) errs.push(`${at}.when.key: expected the key of an earlier field`);
				else if (earlier.readonly === true) errs.push(`${at}.when.key: cannot depend on a read-only field`);
				else {
					const values = Array.isArray(f.when.equals) ? f.when.equals : [f.when.equals];
					if (!values.length) errs.push(`${at}.when.equals: must not be empty`);
					if (earlier.type === "select" && values.some((v: unknown) => !earlier.options?.some((o: any) => o?.value === v))) errs.push(`${at}.when.equals: not an option of ${earlier.key}`);
				}
			}
			if (f.secret === true && "default" in f) errs.push(`${at}.default: a secret field must not have a default`);
			if (f.type !== "select") { if ("options" in f) errs.push(`${at}.options: only select fields take options`); return; }
			if (!Array.isArray(f.options)) { errs.push(`${at}.options: a select field needs options`); return; }
			f.options.forEach((o: any, j: number) => {
				if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.value !== "string" || typeof o.label !== "string") errs.push(`${at}.options[${j}]: expected { "value": ..., "label": ... }`);
			});
			if (f.options.length < 2) errs.push(`${at}.options: a select field needs at least 2 options`);
		});
	}
	return errs;
}

function run(cmd: string[], cwd: string): boolean {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
	return p.exitCode === 0;
}

if (import.meta.main) {
	const ids = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && d.name !== "scripts" && existsSync(join(ROOT, d.name, "package.json"))).map((d) => d.name).filter((n) => !only || n === only);
	if (only && !ids.length) { console.error(`no extension "${only}"`); process.exit(1); }
	let failed = 0;
	for (const id of ids) {
		const dir = join(DIR, id);
		const errs = checkExtension(id);
		let ok = errs.length === 0;
		for (const e of errs) console.error(`${id}: ${e}`);
		if (ok && existsSync(join(dir, "tests"))) {
			// client extensions test with node; server ones with bun (their server tests skip themselves without PIPAYA_APP)
			ok = existsSync(join(dir, "manifest.json")) ? run(["npm", "run", "check", "--silent"], dir) : run(["bun", "test"], dir);
		}
		console.log(`${ok ? "ok  " : "FAIL"} ${id}`);
		if (!ok) failed++;
	}
	process.exit(failed ? 1 : 0);
}
