<script module>
	/* @helpers */
	// A key the server refused stays refused until the stored key changes: some servers block an IP for a while after a
	// few rejected requests, so a wrong key is never retried.
	let rejectedKey = "";
</script>

<script>
	// Microphone button next to the send control (mounted by VoiceSend.svelte). Click: record. Click again: stop, upload to the
	// configured OpenAI-compatible transcription route and append the transcript to the draft. It never sends the message.
	import { onDestroy, untrack } from "svelte";
	// The app's kit as a namespace: an app older than 0.7.1 has no `shortcuts` in it, which is simply `undefined` here (a missing
	// named import would be `undefined` too, never a compile error), and the microphone button keeps working without it.
	import * as kit from "pipaya";
	const { ext, app, getPane } = kit;

	// `offline`: the app has no server connection (its input box is dimmed then), so there is nothing to type into.
	let { offline = false } = $props();
	const pane = getPane();
	const lang = $derived(ext.language);
	const tr = (key, params) => message(lang, key, params);

	let phase = $state("idle"); // idle | starting | recording | transcribing
	let elapsed = $state(0);
	let notice = $state(null); // { text, short }
	let root = $state();

	let stream = null;
	let recorder = null;
	let chunks = [];
	let mime = "";
	let intent = "send"; // what to do when the recorder stops: send | cancel
	let startedAt = 0;
	let tick;
	let hardStop;
	let noticeTimer;
	let upload = null;
	let token = 0;
	let gone = false;
	// The recording overlay: a canvas for the live level, the analyser behind it, and the frame that draws it.
	let levels = $state([]); // 0..1 per bar, empty = nothing to draw (reduced motion shows a plain level instead)
	let audio = null; // { ctx, source, analyser, data, frame }
	const still = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	// The overlay covers the input box, not the bar: the attachment, model and send/stop buttons stay usable while recording.
	let box = $state(null);
	let barHeight = $state(0); // the overlay stops above the bar, so its buttons stay visible and clickable

	const busy = $derived(phase === "starting" || phase === "transcribing");
	// While recording or working the button must stay usable to stop; only an idle button is blocked offline.
	const insecure = typeof window !== "undefined" && !window.isSecureContext;
	const blocked = $derived(busy || (offline && phase === "idle"));

	function say(key, params) {
		clearTimeout(noticeTimer);
		const text = tr(key, params);
		notice = { text, short: tr(`${key}Short`) };
		app.toast(text, "error");
		noticeTimer = setTimeout(() => { notice = null; }, 9000);
	}
	function clearNotice() { clearTimeout(noticeTimer); notice = null; }

	// The level meter: an analyser on the same microphone, drawn on a canvas. Everything it opened is closed here, so no
	// path out of a recording (stop, cancel, error, a shortcut release, the component going away) leaves a microphone or an
	// AudioContext behind.
	function stopMeter() {
		if (!audio) return;
		const { ctx, source, data, frame } = audio;
		audio = null;
		if (frame) cancelAnimationFrame(frame);
		try { source.disconnect(); } catch { /* already gone */ }
		try { data?.analyser?.disconnect?.(); } catch { /* already gone */ }
		try { ctx.close?.(); } catch { /* already closed */ }
		levels = [];
	}

	function startMeter(media) {
		stopMeter();
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return; // no Web Audio: the overlay shows the timer alone
		try {
			const ctx = new Ctx();
			const source = ctx.createMediaStreamSource(media);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.6;
			source.connect(analyser); // not to the destination: the microphone is never played back
			const data = new Uint8Array(analyser.frequencyBinCount);
			audio = { ctx, source, analyser, data, frame: 0 };
			if (still) return; // reduced motion: a plain level, updated by the timer, instead of a moving waveform
			const draw = () => {
				if (!audio) return;
				analyser.getByteFrequencyData(data);
				levels = smoothLevels(levels, waveLevels(data, 28));
				audio.frame = requestAnimationFrame(draw);
			};
			audio.frame = requestAnimationFrame(draw);
		} catch { stopMeter(); }
	}

	function release() {
		clearInterval(tick);
		clearTimeout(hardStop);
		stopMeter();
		if (stream) for (const track of stream.getTracks()) { track.onended = null; try { track.stop(); } catch { /* already stopped */ } }
		stream = null;
	}

	function reset() {
		release();
		recorder = null;
		chunks = [];
		phase = "idle";
	}

	async function begin() {
		clearNotice();
		const settings = ext.settings ?? {};
		// The page must be a secure context before anything else: without it the microphone cannot start at all.
		if (!window.isSecureContext) return say("insecure");
		const base = checkBase(settings.apiBase, location.protocol);
		if (base.problem) {
			say(base.problem);
			app.openSettings?.("extensions");
			return;
		}
		if (!pathOf(settings.transcribePath)) {
			say("badPath");
			app.openSettings?.("extensions");
			return;
		}
		const key = String(settings.apiKey ?? "").trim();
		if (!key) {
			say("needKey");
			app.openSettings?.("extensions");
			return;
		}
		if (key === rejectedKey) return say("badKey", { status: 401 });
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return say("unsupported");

		const mine = ++token;
		phase = "starting";
		let media;
		try {
			media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		} catch (error) {
			if (mine === token && !gone) { phase = "idle"; say(micErrorKind(error)); }
			return;
		}
		// Unmounted or cancelled while the permission prompt was open: close the stream at once.
		if (gone || mine !== token) { for (const track of media.getTracks()) track.stop(); return; }
		stream = media;
		try {
			mime = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
			recorder = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
		} catch {
			reset();
			return say("unsupported");
		}
		const rec = recorder;
		chunks = [];
		intent = "send";
		rec.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
		rec.onerror = () => { intent = "cancel"; reset(); say("micFailed"); };
		rec.onstop = () => void finish(rec, mine);
		// The microphone was unplugged or revoked: finish with what was captured.
		for (const track of media.getAudioTracks()) track.onended = () => stop();
		// A press released while the microphone was still opening (and meant to be thrown away): nothing is kept.
		if (startedByPress && !pressedAt) { for (const track of media.getTracks()) track.stop(); reset(); return; }
		rec.start(1000);
		startedAt = performance.now();
		elapsed = 0;
		phase = "recording";
		startMeter(media);
		tick = setInterval(() => {
			elapsed = performance.now() - startedAt;
			// Reduced motion: no animation, but the level still moves so the user can see that sound arrives.
			if (still && audio) { audio.analyser.getByteFrequencyData(audio.data); levels = waveLevels(audio.data, 28); }
		}, still ? 200 : 250);
		hardStop = setTimeout(stop, MAX_RECORD_MS);
	}

	function stop(next = "send") {
		if (phase !== "recording" || !recorder) return;
		intent = next;
		elapsed = performance.now() - startedAt;
		if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* handled by onstop/onerror */ } }
	}

	async function finish(rec, mine) {
		const length = performance.now() - startedAt;
		const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
		const wanted = intent;
		reset(); // the microphone is closed before the upload starts
		if (gone || mine !== token || wanted === "cancel") return;
		if (length < MIN_RECORD_MS || blob.size < MIN_BLOB_BYTES) return say("tooShort");
		await send(blob);
	}

	async function send(blob) {
		const settings = ext.settings ?? {};
		const key = String(settings.apiKey ?? "").trim();
		const base = String(settings.apiBase ?? "").trim();
		const paneId = pane.id;
		phase = "transcribing";
		upload = new AbortController();
		try {
			const text = await transcribe({
				fetchImpl: (url, init) => fetch(url, init),
				apiBase: base,
				transcribePath: settings.transcribePath,
				pageProtocol: location.protocol,
				apiKey: key,
				model: settings.model,
				language: settings.language,
				blob,
				signal: upload.signal
			});
			if (gone) return;
			phase = "idle";
			insert(text, paneId);
		} catch (error) {
			if (gone) return;
			phase = "idle";
			const kind = error?.kind ?? "network";
			if (kind === "aborted") return;
			if (kind === "badKey") rejectedKey = key;
			if (kind === "needBase" || kind === "needHttps" || kind === "badPath") app.openSettings?.("extensions");
			say(kind, { status: error?.status ?? "", host: hostOf(base), sec: Math.round(UPLOAD_TIMEOUT_MS / 1000) });
		} finally {
			upload = null;
		}
	}

	function insert(text, paneId) {
		// Another chat took the input box meanwhile: do not put the words into the wrong draft.
		if (pane.id !== paneId) return say("paneChanged", { text });
		const box = root?.closest('[data-part="composer"]')?.querySelector("textarea[data-composer]");
		if (!box) {
			app.prefill = text; // the app appends it to the draft
			return;
		}
		const value = joinDraft(box.value, text);
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, value);
		box.dispatchEvent(new Event("input", { bubbles: true })); // keeps the composer's own state in step
		// On a phone, focusing would pop the keyboard up over the result.
		if (!matchMedia("(pointer: coarse)").matches) box.focus({ preventScroll: true });
		try { box.setSelectionRange(value.length, value.length); } catch { /* not focusable */ }
	}

	// The overlay is drawn inside the app's input box (`.box`, `position: relative`), which our component only sits inside:
	// it is found from the DOM and marked, so the box can hide the text under the overlay and the overlay can cover it.
	$effect(() => {
		const el = root?.closest('[data-part="composer.box"]') ?? null;
		box = el;
		if (!el) return;
		const bar = el.querySelector('[data-part="composer.bar"]');
		const measure = () => { barHeight = bar ? Math.round(bar.getBoundingClientRect().height) : 0; };
		measure();
		const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
		if (bar && ro) ro.observe(bar);
		return () => { delete el.dataset.voiceOverlay; ro?.disconnect(); };
	});

	$effect(() => {
		if (!box) return;
		const active = phase === "recording" || phase === "transcribing" || !!notice;
		if (active) box.dataset.voiceOverlay = "active";
		else delete box.dataset.voiceOverlay;
	});

	function onclick() {
		if (phase === "recording") stop();
		else if (phase === "idle") void begin();
	}

	// ── keyboard shortcut ───────────────────────────────────────────────────────────────────────────────────────────
	// Registered through Pipaya Core's shortcut API (needs pipaya 0.7.2+, permissions: ["ui-components", "shortcuts"]).
	// Registered without an initial combo (defaultCombo: null / "none"): the user sets, customizes or clears the combo
	// in Settings > Shortcuts. The current combo is read through the reactive getter `kit.currentShortcut("dictate")`.
	const currentCombo = $derived(shortcutCombo(kit, SHORTCUT_ID));
	const mode = $derived(shortcutMode(ext.settings?.shortcutMode)); // both (default) | toggle | hold
	const hint = $derived(shortcutHint(currentCombo, mode, lang));
	const pane_ = pane; // the component is mounted once per pane: only the focused pane's microphone answers the keys
	let pressedAt = 0; // when the shortcut keys went down; 0 = not pressed
	let startedByPress = false; // the recording was started by that press

	// The keys came up. What that means depends on the mode (`releaseAction`): in `both` a tap keeps recording and a longer
	// press stops (push to talk); in `hold` a too-short press is thrown away; in `toggle` the release means nothing. A reason
	// other than a plain release (blur, hidden tab, shortcut recording, shortcut removed) always ends the recording, and a
	// microphone that is still opening is closed.
	function endPress(reason = "release") {
		if (!pressedAt) return;
		const action = releaseAction(mode, pressedAt, performance.now(), reason);
		if (action === "keep") { pressedAt = 0; return; } // `both`: the tap started recording, the next tap stops it
		pressedAt = 0;
		startedByPress = false;
		if (phase === "recording") stop(action === "send" ? "send" : "cancel");
		else if (phase === "starting") { token++; phase = "idle"; } // begin() closes the stream when it arrives
	}

	function onShortcut(event) {
		if (!pane_.focused) return;
		if (event?.phase === "up") return endPress(event.reason ?? "release");
		if (mode === "toggle") return onclick(); // exactly what clicking the button does
		// `both` and `hold` start on the press. `both` also starts while a tap-started recording runs? No: pressing again is the
		// stop, which the button's own handler does.
		if (phase === "recording") return void onclick();
		if (phase !== "idle") return;
		pressedAt = performance.now();
		startedByPress = true;
		void begin();
	}

	$effect(() => {
		if (typeof kit.shortcuts?.register !== "function") return; // an app older than 0.7.1: the button still works
		let off;
		try {
			// `toggle` only needs the press; `both` and `hold` need the release as well (that is what makes it a hold).
			const handlers = mode === "toggle" ? { down: onShortcut } : { down: onShortcut, up: onShortcut };
			// `register` reads and writes the app's list of shortcuts. Read inside this effect, that list would become one of its
			// own dependencies and the effect would trigger itself without end, so the call is made untracked.
			off = untrack(() => kit.shortcuts.register({ id: SHORTCUT_ID, label: tr("shortcutLabel") }, handlers));
		} catch {
			/* registration failed: Pipaya version or invalid state */
		}
		return () => untrack(() => { off?.(); endPress("removed"); }); // a held recording must not outlive its shortcut (and removing it writes the list too)
	});

	onDestroy(() => {
		gone = true;
		token++;
		clearTimeout(noticeTimer);
		intent = "cancel";
		if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch { /* closing anyway */ } }
		upload?.abort();
		release();
	});

	const baseLabel = $derived(insecure && phase === "idle" ? tr("insecure") : phase === "recording" ? tr("stopRecording") : phase === "transcribing" ? tr("transcribing") : tr("idle"));
	const label = $derived(baseLabel);
	// The tooltip also names the shortcut and its mode; the accessible name stays the plain action.
	const tip = $derived(hint ? `${baseLabel} (${hint})` : baseLabel);
</script>

{#if box}
	{@const state = phase === "recording" ? "recording" : phase === "transcribing" ? "transcribing" : notice ? "error" : ""}
	{#if state}
		<!-- Purely visual and out of the accessibility tree: the state is announced once by the `.sr` line below.
		     Covers the input area only, never the bar (bottom: var(--bar)). -->
		<div
			class="overlay"
			class:rec={state === "recording"}
			class:busy={state === "transcribing"}
			class:err={state === "error"}
			style:--bar={`${barHeight}px`}
			aria-hidden="true"
		>
			{#if state === "recording"}
				<div class="row">
					<div class="wave">
						{#each levels.length ? levels : Array(28).fill(0.12) as level, i (i)}<i style:--l={level.toFixed(3)}></i>{/each}
					</div>
					<div class="big">{formatTime(elapsed)}</div>
					<div class="hint">{mode === "hold" ? tr("overlayHintHold") : tr("overlayHint")}</div>
					<div class="actions">
						<button type="button" class="btn-cancel" onclick={() => stop("cancel")} aria-label={tr("cancel")} title={tr("cancel")}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
						</button>
						<button type="button" class="btn-stop" onclick={() => stop("send")} aria-label={tr("stopRecording")} title={tr("stopRecording")}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" /><path d="M19 11a7 7 0 0 1-14 0M12 18v3" /><circle class="solid" cx="18.5" cy="5.5" r="3" /></svg>
						</button>
					</div>
				</div>
			{:else if state === "transcribing"}
				<div class="row">
					<svg class="spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
					<span class="big small">{tr("overlayTranscribing")}</span>
				</div>
			{:else}
				<div class="row err">
					<span class="badge">{notice.short}</span>
					<span class="hint wide">{notice.text}</span>
					<button type="button" class="btn-cancel" onclick={clearNotice} aria-label={tr("cancel")} title={tr("cancel")}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
					</button>
				</div>
			{/if}
		</div>
	{/if}
{/if}

<div class="vi" bind:this={root} data-state={phase}>
	<!-- Screen readers get the state once, in words. The visible timer ticks every second and stays out of the live region. -->
	<span class="sr" role="status" aria-live="polite">{phase === "recording" ? tr("recording") : phase === "transcribing" ? tr("transcribing") : notice ? notice.text : ""}</span>
	<span class="status">
		{#if phase === "recording"}
			<span class="chip live">
				<i class="dot" aria-hidden="true"></i><span class="txt" aria-hidden="true">{formatTime(elapsed)}</span>
				<button type="button" class="x" aria-label={tr("cancel")} title={tr("cancel")} onclick={() => stop("cancel")}>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
				</button>
			</span>
		{:else if phase === "transcribing"}
			<span class="chip" aria-hidden="true"><span class="txt">{tr("transcribingShort")}</span></span>
		{:else if notice}
			<span class="chip bad" title={notice.text} aria-hidden="true"><span class="txt">{notice.short}</span></span>
		{/if}
	</span>

	<button
		type="button"
		class="mic"
		class:rec={phase === "recording"}
		class:busy={busy}
		class:err={!!notice && phase === "idle"}
		class:unavailable={insecure}
		aria-disabled={insecure || undefined}
		aria-label={label}
		aria-pressed={phase === "recording"}
		title={tip}
		disabled={blocked}
		{onclick}
	>
		{#if phase === "recording"}
			<!-- a microphone with a recording dot: the app's own stop button is a square, and the two must not look alike -->
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" /><path d="M19 11a7 7 0 0 1-14 0M12 18v3" /><circle class="solid" cx="18.5" cy="5.5" r="3" /></svg>
		{:else if busy}
			<svg class="spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
		{:else}
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" /><path d="M19 11a7 7 0 0 1-14 0M12 18v3" /></svg>
		{/if}
	</button>
</div>

<style>
	/* Same family as the app's send control (SendControls .send / .stack .send.stop): a 38px round button, grey at rest, danger
	   tint while recording, solid pre-mixed colours instead of opacity when it cannot be used. Only the app's tokens are used.
	   The status chip opens to the left of the microphone, so the microphone stays beside the send control and the chip is
	   what gives way (its text is cut with an ellipsis) when the bar is narrow, never the send control. */
	/* The overlay fills the input area of `.box` (position: relative) and ends strictly above the bar
	   (`bottom: var(--bar, 48px)`), so all bar controls (attachments, model, send/stop, mic) remain
	   fully visible and directly clickable without any overlay blocking or blurring them.
	   The draft underneath stays faintly visible through the frosted glass effect. */
	.overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: var(--bar, 48px);
		z-index: 1;
		display: grid;
		place-items: center;
		overflow: hidden;
		padding: 4px 12px;
		box-sizing: border-box;
		border-top-left-radius: inherit;
		border-top-right-radius: inherit;
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
		background: color-mix(in srgb, var(--bg-elev) 80%, transparent);
		backdrop-filter: blur(3px);
		pointer-events: none; /* background is click-through to draft */
	}
	.overlay .row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		min-width: 0;
		max-width: 100%;
		flex-wrap: nowrap;
	}
	.overlay .big {
		font-size: 22px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
		color: var(--text);
		line-height: 1;
		flex: none;
	}
	.overlay .big.small {
		font-size: var(--fs-sm);
		font-weight: 500;
		color: var(--text-dim);
	}
	.overlay .hint {
		font-size: var(--fs-sm);
		color: var(--text-dim);
		white-space: nowrap;
		flex: none;
	}
	.overlay .hint.wide {
		font-size: var(--fs-xs);
		white-space: normal;
	}
	.overlay.rec .big {
		color: var(--danger);
	}
	.overlay .badge {
		display: inline-flex;
		align-items: center;
		flex: none;
		height: 24px;
		padding: 0 10px;
		border-radius: 999px;
		font-size: var(--fs-sm);
		background: var(--danger-soft);
		color: color-mix(in srgb, var(--danger) 80%, var(--text));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 40%, transparent);
	}
	.overlay .spin {
		width: 18px;
		height: 18px;
		flex: none;
		fill: none;
		stroke: var(--text-dim);
		stroke-width: 2.1;
		stroke-linecap: round;
	}
	/* Waveform bars */
	.wave {
		display: flex;
		align-items: flex-end;
		justify-content: center;
		gap: 2px;
		flex: 0 1 180px;
		min-width: 44px;
		height: 28px;
	}
	.wave i {
		flex: 1 1 0;
		min-width: 2px;
		max-width: 6px;
		height: calc(10% + var(--l) * 90%);
		border-radius: 999px;
		background: var(--danger);
		opacity: 0.85;
		transition: height 90ms linear;
	}
	/* Overlay action buttons: explicitly interactive while overlay background passes clicks */
	.overlay .actions {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.overlay .btn-cancel,
	.overlay .btn-stop {
		pointer-events: auto;
		display: grid;
		place-items: center;
		border-radius: 50%;
		border: 0;
		cursor: pointer;
		user-select: none;
		touch-action: manipulation;
		transition:
			background var(--motion-fast) var(--ease-std),
			color var(--motion-fast) var(--ease-std),
			transform var(--motion-fast) var(--ease);
	}
	.overlay .btn-cancel {
		width: 28px;
		height: 28px;
		background: transparent;
		color: var(--text-dim);
	}
	.overlay .btn-cancel svg {
		width: 15px;
		height: 15px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.2;
		stroke-linecap: round;
	}
	.overlay .btn-cancel:hover {
		background: var(--bg-active);
		color: var(--text);
	}
	.overlay .btn-cancel:active {
		transform: scale(0.9);
	}
	.overlay .btn-stop {
		width: 32px;
		height: 32px;
		background: var(--danger-soft);
		color: var(--danger);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 40%, transparent);
	}
	.overlay .btn-stop svg {
		width: 17px;
		height: 17px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.1;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.overlay .btn-stop .solid {
		fill: currentColor;
		stroke: currentColor;
		stroke-width: 1;
	}
	.overlay .btn-stop:hover {
		background: color-mix(in srgb, var(--danger) 22%, transparent);
	}
	.overlay .btn-stop:active {
		transform: scale(0.9);
	}

	@media (max-width: 580px) {
		.overlay .hint { display: none; }
		.overlay .row { gap: 8px; }
		.overlay .big { font-size: 19px; }
		.wave { flex-basis: 110px; }
	}

	/* While the overlay is active, the compact status chip in the bar is hidden to avoid duplicate time displays. */
	:global([data-part="composer.box"][data-voice-overlay="active"]) .status {
		display: none;
	}

	.vi { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; flex: 0 1 auto; }
	.status { display: inline-flex; align-items: center; min-width: 0; }
	.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }

	.mic {
		display: grid; place-items: center; flex: none; width: 38px; height: 38px; padding: 0; border: 0; border-radius: 50%;
		background: var(--bg-active); color: var(--text-faint); cursor: pointer;
		-webkit-touch-callout: none; user-select: none; touch-action: manipulation;
		transition: background var(--motion-fast) var(--ease-std), color var(--motion-fast) var(--ease-std), box-shadow var(--motion-fast) var(--ease-std), transform var(--motion-fast) var(--ease);
	}
	.mic svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 2.1; stroke-linecap: round; stroke-linejoin: round; }
	.mic:hover:not(:disabled) { background: var(--border-strong); color: var(--text); }
	.mic:active:not(:disabled) { transform: scale(0.9); }
	.mic .solid { fill: currentColor; stroke: currentColor; stroke-width: 1; }
	/* recording: the app's stop button look */
	.mic.rec, .mic.rec:hover:not(:disabled) { background: var(--danger-soft); color: var(--danger); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 40%, transparent); }
	.mic.rec:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 22%, transparent); }
	.mic.err { color: var(--danger); }
	/* Not a real disabled state when the page is not https: the button stays clickable so pressing it explains why. */
	.mic.unavailable:not(.rec) { color: color-mix(in srgb, var(--text-faint) 60%, var(--bg-active)); }
	.mic.unavailable:hover:not(:disabled) { background: var(--bg-active); color: color-mix(in srgb, var(--text-faint) 60%, var(--bg-active)); }
	/* cannot be used right now (offline, working): solid pre-mixed colours, like the send control when it is disabled */
	.mic:disabled { cursor: default; color: color-mix(in srgb, var(--text-faint) 60%, var(--bg-active)); }
	.mic.busy:disabled { color: var(--text-dim); }
	.spin { animation: vi-spin 0.9s linear infinite; }

	/* status chip: a pill, 28px high (the buttons are 38px), padded 12px so the text never touches the edge */
	.chip {
		flex: 0 1 auto; display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 12em; height: 28px; box-sizing: border-box; padding: 0 12px;
		border-radius: 999px; background: var(--bg-active); color: var(--text-dim);
		font-size: var(--fs-sm); line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap;
	}
	.chip .txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
	/* the text is a little darker than --danger so it reads at 4.5:1 on the light theme too */
	.chip.live, .chip.bad { background: var(--danger-soft); color: color-mix(in srgb, var(--danger) 80%, var(--text)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 40%, transparent); }
	/* the cancel button lives inside the recording chip, so they read as one control */
	.chip.live { padding: 0 3px 0 11px; }
	.dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--danger); animation: vi-pulse 1.2s ease-in-out infinite; }
	.x { display: grid; place-items: center; flex: none; width: 24px; height: 24px; margin-left: 2px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; transition: background var(--motion-fast) var(--ease-std); }
	.x svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
	.x:hover { background: color-mix(in srgb, var(--danger) 18%, transparent); }
	.x:focus-visible { outline-offset: 0; }

	@keyframes vi-spin { to { transform: rotate(360deg); } }
	@keyframes vi-pulse { 50% { opacity: 0.35; } }
	@media (prefers-reduced-motion: reduce) { .spin, .dot { animation: none; } .mic, .x { transition: none; } .mic:active:not(:disabled) { transform: none; } .wave i { transition: none; } }
	@media (max-width: 480px) { .chip { max-width: 8em; padding: 0 10px; font-size: var(--fs-xs); } .chip.live { padding: 0 3px 0 10px; } }
</style>
