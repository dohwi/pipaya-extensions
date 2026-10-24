import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const parts = await Promise.all(['i18n.mjs', 'logos.mjs', 'model.mjs', 'view.mjs'].map(name => readFile(new URL(`src/${name}`, root), 'utf8')));
const worker = await readFile(new URL('src/extension.js', root), 'utf8');
const code = parts.join('\n').replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\n' + worker;
// Parse as the exact async function body used by the pipaya worker, without executing it.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
new AsyncFunction('sdk', code);
// The gauges are Svelte components that run in the pipaya app (ui-components); the worker above only polls.
const components = Object.fromEntries(await Promise.all(['Gauge', 'Ring'].map(async name => [name, await readFile(new URL(`src/components/${name}.svelte`, root), 'utf8')])));
const mounts = [{ slot: 'header.end', component: 'Gauge' }];
const output = JSON.stringify({ manifest, components, mounts, code }, null, 2) + '\n';
if (Buffer.byteLength(code) > 128 * 1024 || Buffer.byteLength(output) > 256 * 1024) throw new Error('SDK package size limit exceeded');
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL(`dist/${manifest.id}.json`, root), output);
console.log(`Built ${fileURLToPath(new URL(`dist/${manifest.id}.json`, root))} (${Buffer.byteLength(output)} bytes)`);
