<script module>
	/* @helpers */
	// A key the server refused stays refused until the stored key changes: some servers (CLIProxyAPI, for one) block
	// an IP for a while after a few rejected requests, so a wrong key is never retried.
	let rejectedKey = "";
</script>

<script>
	// Microphone button for the composer toolbar. Click: record. Click again: stop, upload to the CLIProxyAPI
	// mistral-support route (Mistral Voxtral) and append the transcript to the draft. It never sends the message.
	import { onDestroy } from "svelte";
	import { ext, app, getPane } from "pipaya";

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
		if (!originOf(settings.apiBase)) {
			say("needBase");
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
		if (!window.isSecureContext) return say("insecure");
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
			if (kind === "needBase" || kind === "badPath") app.openSettings?.("extensions");
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

	onDestroy(() => {
		gone = true;
		token++;
		clearTimeout(noticeTimer);
		intent = "cancel";
		if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch { /* closing anyway */ } }
		upload?.abort();
		release();
	});

	const label = $derived(phase === "recording" ? tr("recording") : phase === "transcribing" ? tr("transcribing") : tr("idle"));
</script>

<div class="vi" bind:this={root} data-state={phase}>
	<button
		type="button"
		class="iconbtn mic"
		class:rec={phase === "recording"}
		class:err={!!notice && phase === "idle"}
		aria-label={label}
		aria-pressed={phase === "recording"}
		title={label}
		disabled={busy}
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

	<span class="status" role="status" aria-live="polite">
		{#if phase === "recording"}
			<span class="chip live"><i class="dot"></i>{formatTime(elapsed)}</span>
			<button type="button" class="iconbtn sm cancel" aria-label={tr("cancel")} title={tr("cancel")} onclick={() => stop("cancel")}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
			</button>
		{:else if phase === "transcribing"}
			<span class="chip">{tr("transcribingShort")}</span>
		{:else if notice}
			<span class="chip bad" title={notice.text}>{notice.short}</span>
		{/if}
	</span>
</div>

<style>
	.vi { display: inline-flex; align-items: center; gap: 2px; min-width: 0; flex: 0 1 auto; }
	.status { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
	.mic.rec { color: var(--danger); background: var(--danger-soft); }
	.mic.err { color: var(--danger); }
	.mic:disabled { opacity: 0.7; cursor: default; }
	.mic .solid { fill: currentColor; stroke: currentColor; }
	.spin { animation: vi-spin 0.9s linear infinite; }
	.chip { display: inline-flex; align-items: center; gap: 6px; max-width: 9em; padding: 0 4px; overflow: hidden; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; color: var(--text-dim); white-space: nowrap; text-overflow: ellipsis; }
	.chip.live { color: var(--danger); }
	.chip.bad { color: var(--danger); }
	.dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--danger); animation: vi-pulse 1.2s ease-in-out infinite; }
	.cancel { color: var(--text-faint); }
	@keyframes vi-spin { to { transform: rotate(360deg); } }
	@keyframes vi-pulse { 50% { opacity: 0.35; } }
	@media (prefers-reduced-motion: reduce) { .spin, .dot { animation: none; } }
	@media (max-width: 480px) { .chip { max-width: 6.5em; padding: 0 2px; font-size: var(--fs-xs); } }
</style>
