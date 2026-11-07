import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

// A trusted component may import only `pipaya`, `svelte*` and sibling components, so the pure helpers
// (src/helpers.mjs, unit-tested on their own) are inlined into the component's <script module>.
const helpers = (await readFile(new URL('src/helpers.mjs', root), 'utf8')).replace(/^import .*$/gm, '').replace(/^export /gm, '');
const source = await readFile(new URL('src/components/VoiceButton.svelte', root), 'utf8');
if (!source.includes('/* @helpers */')) throw new Error('VoiceButton.svelte lost its /* @helpers */ marker');
const component = source.replace('/* @helpers */', () => helpers);
const send = await readFile(new URL('src/components/VoiceSend.svelte', root), 'utf8');

// The button sits beside the send control by replacing the app's `composer.send` part (the original control is
// still drawn by the part's `fallback`), so there is no mount. No Worker code: the microphone, the upload and the key all live in the component (ui-components).
const output = JSON.stringify({ manifest, components: { VoiceButton: component, VoiceSend: send }, replaces: { 'composer.send': 'VoiceSend' } }, null, 2) + '\n';
if (Buffer.byteLength(component) > 64 * 1024 || Buffer.byteLength(output) > 256 * 1024) throw new Error('SDK package size limit exceeded');
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL(`dist/${manifest.id}.json`, root), output);
console.log(`Built ${fileURLToPath(new URL(`dist/${manifest.id}.json`, root))} (${Buffer.byteLength(output)} bytes)`);
