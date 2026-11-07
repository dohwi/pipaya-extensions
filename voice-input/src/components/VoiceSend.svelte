<script>
	// Replaces the composer's send control (`composer.send`) so the microphone sits right next to it. The original
	// control is drawn untouched by `fallback`: send, queue, steer, stop and the compaction cancel all stay the app's own.
	// This only adds the microphone to its left. The part's other props (canSend, hasInput, running, compacting, send,
	// stop) are deliberately not used: the original control already owns them.
	import { app } from "pipaya";
	import VoiceButton from "./VoiceButton.svelte";

	let { fallback } = $props();
</script>

<div class="vs">
	<VoiceButton offline={app.net !== "online"} />
	<div class="orig">{@render fallback()}</div>
</div>

<style>
	/* The send control keeps its own size and never shrinks; the microphone area is the part that gives way. */
	.vs { display: flex; align-items: center; justify-content: flex-end; gap: 2px; flex: 0 1 auto; min-width: 0; max-width: 100%; }
	.orig { display: contents; }
</style>
