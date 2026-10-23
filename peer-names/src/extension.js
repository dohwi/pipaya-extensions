// Async SDK function body. Shows the other chats of this server by @name: labels, `@` completion, and the bubble of a message another chat sent.
// The names themselves live in the server (peer-tools answers `overview`); this side only draws them.
const SENDER = '^\\[from (@[^,\\]\\n]+), another session on this server;[^\\]\\n]*\\]';
let timer;
let busy = false;
let again = false;

async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const overview = await sdk.server.call('peer-tools', 'overview', {});
    const labels = labelsOf(overview);
    await sdk.sessionLabels.set(labels);
    await sdk.mentions.set(mentionsOf(overview, typeof navigator === 'object' ? navigator.language : 'en'));
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
  if (event.type === 'session_created' || event.type === 'session_updated' || event.type === 'session_deleted' || event.type === 'run_finished') schedule();
});
await sdk.server.on(event => {
  if (event.extension === 'peer-tools') schedule();
});
await refresh();
