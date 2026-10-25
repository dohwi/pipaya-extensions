// Async SDK function body. Shows the other chats of this server by @name: labels, `@` completion, and the bubble of a message another chat sent.
// The names themselves live in the server (peer-tools answers `overview`); this side only draws them.
const SENDER = '^\\[from (@[^,\\]\\n]+), another session on this server;[^\\]\\n]*\\]';
let timer;
let busy = false;
let again = false;

let language = '';
const REFRESH = new Set(['session_created', 'session_updated', 'session_deleted', 'run_finished', 'group_created', 'group_updated', 'group_deleted', 'extensions_updated']);

// Names follow the UI language (민수 <-> Minsu): peer-tools renames, then tells us through a names_changed event.
async function followLanguage() {
  try {
    const next = (await sdk.context.get()).language;
    if (!next || next === language) return;
    language = next;
    await sdk.server.call('peer-tools', 'localize', { lang: next });
  } catch (error) {
    // offline or peer-tools missing: names just stay
  }
}

async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const overview = await sdk.server.call('peer-tools', 'overview', {});
    const labels = labelsOf(overview);
    await sdk.sessionLabels.set(labels);
    // Menu words follow the app's language (from the host), not the browser's.
    await sdk.mentions.set(mentionsOf(overview, language || 'en'));
  } catch (error) {
    // The server may be offline or peer-tools not installed: show nothing rather than stale names.
    await sdk.sessionLabels.set({}).catch(() => {});
    await sdk.mentions.set([]).catch(() => {});
  } finally {
    busy = false;
    if (again) { again = false; schedule(); }
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => { void refresh(); }, 300);
}

await sdk.messages.setHeader(SENDER);
await sdk.events.on(event => {
  if (event.type === 'language_changed') void followLanguage().then(schedule);
  // Groups are @-addressable too, so a group change refreshes the completions.
  if (REFRESH.has(event.type)) schedule();
});
await sdk.server.on(event => {
  if (event.extension === 'peer-tools') schedule();
});
await followLanguage();
await refresh();
