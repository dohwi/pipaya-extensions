<script module>
	/* @helpers */
	// A key the server refused stays refused until the stored key changes: some servers block an IP for a while after a
	// few rejected requests, so a wrong key is never retried.
	let rejectedKey = "";
</script>

<script>
	// Microphone button next to the send control (mounted by VoiceSend.svelte). Click: record. Click again: stop, upload to the
	// configured OpenAI-compatible transcription route and append the transcript to the draft. It never sends the message.
	import { onDestroy } from "svelte";
	import { ext, app, getPane } from "pipaya";

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

	function release() {
		clearInterval(tick);
		clearTimeout(hardStop);
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
		// A hold shortcut released while the microphone was still opening: nothing is kept.
		if (holdingStart && !heldDownAt) { for (const track of media.getTracks()) track.stop(); reset(); return; }
		rec.start(1000);
		startedAt = performance.now();
		elapsed = 0;
		phase = "recording";
		tick = setInterval(() => { elapsed = performance.now() - startedAt; }, 250);
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

	function onclick() {
		if (phase === "recording") stop();
		else if (phase === "idle") void begin();
	}

	// ── keyboard shortcut ───────────────────────────────────────────────────────────────────────────────────────────
	// No default: the setting is empty until the user types a combination, and then nothing is listening at all. The
	// listeners are on `window` in the capture-free bubble phase, after the app's own handler, so a combination the app
	// already uses wins (the app calls preventDefault and this code steps aside).
	const shortcut = $derived(parseShortcut(ext.settings?.shortcut));
	const mode = $derived(ext.settings?.shortcutMode === "hold" ? "hold" : "toggle");
	const hint = $derived(shortcutLabel(shortcut, mode, lang));
	let heldDownAt = 0; // when the hold key went down; 0 = not holding
	let holdingStart = false; // the key is down and the recording is being started by it

	function endHold(next = "send") {
		if (!heldDownAt) return;
		const verdict = holdVerdict(heldDownAt, performance.now());
		heldDownAt = 0;
		holdingStart = false;
		if (phase === "recording") stop(verdict === "send" && next === "send" ? "send" : "cancel");
		else if (phase === "starting") { token++; phase = "idle"; } // released before the microphone opened: abandon it (begin() closes the stream when it arrives)
	}

	function onKeyDown(e) {
		if (!shortcut.ok || !shortcut.combo) return;
		if (!shouldHandleKey(e, { recordingKey: app.prefs?.recordingKey })) return;
		if (!matchesShortcut(shortcut, e)) return;
		// The app handled this key first (one of its own shortcuts): it wins.
		if (e.defaultPrevented) return;
		e.preventDefault(); // Alt+letter must not type a character into the input box
		if (e.repeat) return; // a held key repeats: only the first press counts
		if (mode === "hold") {
			if (phase !== "idle") return;
			heldDownAt = performance.now();
			holdingStart = true;
			void begin();
		} else if (phase === "recording") stop();
		else if (phase === "idle") void begin();
	}

	function onKeyUp(e) {
		if (mode !== "hold" || !heldDownAt) return;
		if (releasesShortcut(shortcut, e) || releasesModifier(shortcut, e)) endHold();
	}

	// The window lost the keyboard (alt-tab, a dialog stole focus, the tab was hidden): the key-up will never arrive.
	function onFocusLoss() { endHold("send"); }
	function onHidden() { if (document.hidden) endHold("send"); }

	$effect(() => {
		// Registered only while a valid combination is set. Changing the setting re-runs this and swaps the listeners.
		if (!shortcut.ok || !shortcut.combo) return;
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", onFocusLoss);
		document.addEventListener("visibilitychange", onHidden);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", onFocusLoss);
			document.removeEventListener("visibilitychange", onHidden);
			endHold("cancel"); // a held recording must not outlive its shortcut
		};
	});

	// A bad or taken combination is told once, when it is set, not on every key press.
	let warnedFor = "";
	$effect(() => {
		const text = String(ext.settings?.shortcut ?? "").trim();
		if (!text || text === warnedFor) return;
		warnedFor = text;
		if (!shortcut.ok) return void say("shortcutBad");
		const taken = conflictsWithApp(shortcut, app.prefs?.bindings);
		if (taken) say("shortcutConflict");
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

	const baseLabel = $derived(insecure && phase === "idle" ? tr("insecure") : phase === "recording" ? tr("recording") : phase === "transcribing" ? tr("transcribing") : tr("idle"));
	const label = $derived(baseLabel);
	// The tooltip also names the shortcut and its mode; the accessible name stays the plain action.
	const tip = $derived(hint ? `${baseLabel} (${hint})` : baseLabel);
</script>

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
			<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="solid" x="7" y="7" width="10" height="10" rx="2" /></svg>
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
	@media (prefers-reduced-motion: reduce) { .spin, .dot { animation: none; } .mic, .x { transition: none; } .mic:active:not(:disabled) { transform: none; } }
	@media (max-width: 480px) { .chip { max-width: 8em; padding: 0 10px; font-size: var(--fs-xs); } .chip.live { padding: 0 3px 0 10px; } }
</style>
