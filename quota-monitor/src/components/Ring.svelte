<script module>
	let seq = 0;
	// Only one detail popover may be visible at a time.
	let closeActive = null;
</script>

<script>
	let { gauge, strings, preferAbove = false } = $props();

	const NAMED = ["accent", "ok", "warn", "danger"];
	const OPEN_DELAY = 80, CLOSE_DELAY = 120, MARGIN = 8, GAP = 6;
	const fill = (text, params) => String(text ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));

	const meter = (item) => {
		const max = item.max ?? 100;
		const known = item.value !== null && item.value !== undefined;
		const ratio = known ? Math.min(Math.max(item.value / max, 0), 1) : 0;
		const color = item.color ?? "accent";
		return {
			known,
			ratio,
			percent: (ratio * 100).toFixed(2),
			named: NAMED.includes(color) ? color : "",
			hex: NAMED.includes(color) ? undefined : color,
			max
		};
	};
	const shortLabel = $derived(strings.shortWindow || "5h");
	const weeklyLabel = $derived(strings.weeklyWindow || "7d");
	const byPlanLabel = $derived(strings.byPlan || "By plan");

	// Each entry in gauge.rings maps to one vertical bar column underneath the brand logo:
	// 1 column for single-family providers (Claude/GPT/Gemini), 2 side-by-side columns for Antigravity (left=Gemini, right=Claude/GPT).
	// Within each column, top bar = 5h and bottom bar = 7d when both windows are reported; single bar otherwise.
	const columns = $derived(gauge.rings.map((ring) => {
		const m = meter(ring);
		const dual = ring.short !== null && ring.short !== undefined && ring.weekly !== null && ring.weekly !== undefined;
		const top = dual ? meter({ value: ring.short, color: ring.shortColor ?? ring.color, max: ring.max }) : null;
		const bottom = dual ? meter({ value: ring.weekly, color: ring.weeklyColor ?? ring.color, max: ring.max }) : null;
		return {
			...m,
			dual,
			top,
			bottom,
			label: ring.label ?? gauge.label,
			value: ring.value,
			text: dual
				? `${shortLabel} ${Math.round(top.ratio * 100)}% / ${weeklyLabel} ${Math.round(bottom.ratio * 100)}%`
				: (m.known ? `${Math.round(m.ratio * 100)}%` : strings.unknown)
		};
	}));
	const multiCol = $derived(columns.length > 1);
	const details = $derived(gauge.details);
	const updatedAt = $derived(details?.updatedAt);
	const rows = $derived((details?.rows ?? []).map((row, index, all) => {
		const m = meter(row);
		const newGroup = row.group !== undefined && row.group !== all[index - 1]?.group;
		const summary = row.summary === true;
		const tierDual = row.sub === true && ("short" in row || "weekly" in row);
		const prev = all[index - 1];
		const prevTierDual = prev?.sub === true && ("short" in prev || "weekly" in prev);
		const shortMeter = tierDual ? meter({ value: row.short, color: row.shortColor ?? row.color, max: row.max }) : null;
		const weeklyMeter = tierDual ? meter({ value: row.weekly, color: row.weeklyColor ?? row.color, max: row.max }) : null;
		const alertTone = (item) => (item && (item.named === "warn" || item.named === "danger") ? item.named : "");
		return {
			...m,
			heading: newGroup && !summary ? row.group : undefined,
			divider: newGroup && index > 0,
			summary,
			tierDual,
			tierHead: tierDual && (!prevTierDual || newGroup),
			valueTone: alertTone(m),
			shortMeter,
			weeklyMeter,
			shortText: shortMeter?.known ? `${Math.round(shortMeter.ratio * 100)}%` : "—",
			weeklyText: weeklyMeter?.known ? `${Math.round(weeklyMeter.ratio * 100)}%` : "—",
			shortTone: alertTone(shortMeter),
			weeklyTone: alertTone(weeklyMeter),
			label: row.label,
			caption: row.caption,
			sub: row.sub === true,
			text: m.known ? `${Math.round(m.ratio * 100)}%` : strings.unknown
		};
	}));

	let now = $state(Date.now());
	function ago(ms) {
		const sec = Math.floor(Math.max(0, ms) / 1000);
		if (sec < 60) return fill(strings.sec, { n: sec });
		const min = Math.floor(sec / 60);
		if (min < 60) return fill(strings.min, { n: min });
		const hour = Math.floor(min / 60);
		return hour < 24 ? fill(strings.hour, { n: hour }) : fill(strings.day, { n: Math.floor(hour / 24) });
	}
	const updatedText = $derived(updatedAt === undefined ? "" : fill(strings.updated, { ago: ago(now - updatedAt) }));
	const title = $derived(details ? undefined : [gauge.hint, gauge.stale ? strings.stale : ""].filter(Boolean).join(" · ") || undefined);
	const summary = $derived(rows.map((r) => (r.tierDual ? `${r.label}: ${shortLabel} ${r.shortText}, ${weeklyLabel} ${r.weeklyText}` : `${r.label}: ${r.text}`)).join(", "));
	const description = $derived([gauge.hint, gauge.stale && updatedAt === undefined ? strings.stale : "", details ? [details.title, summary].filter(Boolean).join(": ") : ""].filter(Boolean).join(". ") || undefined);

	const popId = `quota-detail-${++seq}`;
	let el = $state();
	let popEl = $state();
	let open = $state(false);
	let placement = $state("below");
	let timer;
	let pointerDown = false;

	const clear = () => { clearTimeout(timer); timer = undefined; };
	const later = (fn, ms) => { clear(); timer = setTimeout(fn, ms); };

	function place() {
		if (!el || !popEl) return;
		const a = el.getBoundingClientRect();
		const vw = window.innerWidth, vh = window.innerHeight;
		popEl.style.maxHeight = "";
		let w = popEl.offsetWidth, h = popEl.offsetHeight;
		const below = vh - a.bottom - GAP - MARGIN;
		const above = a.top - GAP - MARGIN;
		const goAbove = preferAbove ? (above >= h || above > below) : (below < h && above > below);
		const space = Math.max(0, goAbove ? above : below);
		if (h > space && space > 60) { popEl.style.maxHeight = `${Math.floor(space)}px`; h = popEl.offsetHeight; }
		const left = Math.max(MARGIN, Math.min(a.left + a.width / 2 - w / 2, vw - w - MARGIN));
		const top = goAbove ? Math.max(MARGIN, a.top - GAP - h) : Math.min(vh - h - MARGIN, a.bottom + GAP);
		placement = goAbove ? "above" : "below";
		popEl.style.left = `${Math.round(left)}px`;
		popEl.style.top = `${Math.round(top)}px`;
		popEl.style.visibility = "visible";
	}

	function show() {
		clear();
		if (!details || open) return;
		if (closeActive && closeActive !== hide) closeActive();
		closeActive = hide;
		open = true;
	}
	function hide() {
		clear();
		if (closeActive === hide) closeActive = null;
		open = false;
	}
	function portal(node) {
		document.body.appendChild(node);
		return { destroy() { node.remove(); } };
	}
	$effect(() => {
		if (!open || updatedAt === undefined) return;
		now = Date.now();
		const id = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(id);
	});
	$effect(() => {
		if (!open || !popEl) return;
		place();
		const dismiss = () => hide();
		const onScroll = (event) => { if (!popEl?.contains(event.target)) hide(); };
		const onKey = (event) => { if (event.key === "Escape") hide(); };
		const onOutside = (event) => { if (!el?.contains(event.target) && !popEl?.contains(event.target)) hide(); };
		window.addEventListener("resize", dismiss);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onOutside, true);
		return () => {
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onOutside, true);
		};
	});
	$effect(() => () => hide());

	const hovering = (event) => event.pointerType !== "touch";
</script>

<!-- A gauge with a tooltip or details popover is focusable so keyboard users can reach it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={el}
	class="gauge"
	class:stale={gauge.stale}
	role="group"
	aria-label={gauge.label}
	aria-description={description}
	aria-describedby={open ? popId : undefined}
	{title}
	tabindex={title || details ? 0 : undefined}
	onpointerenter={(e) => { if (hovering(e)) later(show, OPEN_DELAY); }}
	onpointerleave={(e) => { if (hovering(e)) later(hide, CLOSE_DELAY); }}
	onpointerdown={(e) => { pointerDown = true; if (e.pointerType === "touch" && details) (open ? hide() : show()); }}
	onpointerup={() => setTimeout(() => { pointerDown = false; }, 0)}
	onfocus={() => { if (!pointerDown) show(); }}
	onblur={() => { pointerDown = false; later(hide, CLOSE_DELAY); }}
>
	<div class="tile">
		{#if gauge.icon}
			<svg class="glyph" viewBox={gauge.icon.viewBox} aria-hidden="true" focusable="false">
				{#each gauge.icon.paths as path}
					<path d={path.d} fill={path.fill ?? "currentColor"} fill-rule={path.fillRule ?? "nonzero"} />
				{/each}
			</svg>
		{/if}
		<div class="bars-wrap" class:multi={multiCol} aria-hidden="true">
			{#each columns as col}
				<div class="bar-col" class:single={!col.dual}>
					{#if col.dual}
						<div class="bar-track" class:unknown={!col.top.known}>
							{#if col.top.known && col.top.ratio > 0}
								<div class="bar-fill {col.top.named}" style:width="{col.top.percent}%" style:background={col.top.hex}></div>
							{/if}
						</div>
						<div class="bar-track" class:unknown={!col.bottom.known}>
							{#if col.bottom.known && col.bottom.ratio > 0}
								<div class="bar-fill {col.bottom.named}" style:width="{col.bottom.percent}%" style:background={col.bottom.hex}></div>
							{/if}
						</div>
					{:else}
						<div class="bar-track solo" class:unknown={!col.known}>
							{#if col.known && col.ratio > 0}
								<div class="bar-fill {col.named}" style:width="{col.percent}%" style:background={col.hex}></div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if gauge.stale}<span class="badge" aria-hidden="true"></span>{/if}
		{#each columns as col}
			<span class="sr-only" role="progressbar" aria-label={col.label} aria-valuemin="0" aria-valuemax={col.max} aria-valuenow={col.known ? col.value : undefined} aria-valuetext={col.text}></span>
		{/each}
	</div>
</div>

{#if open && details}
	<div use:portal bind:this={popEl} id={popId} class="qm-pop {placement}" role="tooltip" style="visibility: hidden" onpointerenter={clear} onpointerleave={(e) => { if (hovering(e)) later(hide, CLOSE_DELAY); }}>
		{#if details.title}<div class="pop-title">{details.title}</div>{/if}
		<div class="pop-body">
			{#each rows as row}
				{#if row.heading}<div class="pop-group" class:divider={row.divider}>{row.heading}</div>{/if}
				{#if row.tierHead}
					<div class="pop-tier-head">
						<span>{byPlanLabel}</span>
						<span class="pop-tier-cols" aria-hidden="true"><span>{shortLabel}</span><span>{weeklyLabel}</span></span>
					</div>
				{/if}
				<div class="pop-row" class:summary={row.summary} class:sub={row.sub} class:tier-dual={row.tierDual} class:divider={row.divider && !row.heading}>
					{#if row.tierDual}
						<div class="pop-tier-line">
							<span class="pop-label" title={row.label}>{row.label}</span>
							<span class="pop-tier-vals">
								<span class="pop-val {row.shortTone}" class:unknown={!row.shortMeter.known}>{row.shortText}</span>
								<span class="pop-val {row.weeklyTone}" class:unknown={!row.weeklyMeter.known}>{row.weeklyText}</span>
							</span>
						</div>
					{:else}
						<div class="pop-line">
							<span class="pop-label" title={row.label}>{row.label}</span>
							<div class="pop-track" class:unknown={!row.known}>
								{#if row.known && row.ratio > 0}<div class="pop-fill {row.named}" style:width="{row.percent}%" style:background={row.hex}></div>{/if}
							</div>
							<span class="pop-value {row.valueTone}" class:unknown={!row.known}>{row.text}</span>
						</div>
					{/if}
					{#if row.caption}<div class="pop-caption">{row.caption}</div>{/if}
				</div>
			{/each}
		</div>
		{#if updatedText || gauge.stale}<div class="pop-updated" class:stale={gauge.stale}>{updatedText || strings.stale}</div>{/if}
	</div>
{/if}

<style>
	.gauge { position: relative; display: inline-flex; align-items: center; flex: none; max-width: 100%; border-radius: 6px; -webkit-tap-highlight-color: transparent; transition: background var(--motion-normal) var(--ease); }
	.gauge:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
	.gauge:focus:not(:focus-visible) { outline: none; }
	.gauge:focus-visible { outline: 1.5px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
	.gauge.stale .tile { opacity: 0.72; }
	.tile { position: relative; display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; height: 30px; padding: 0 5px; }
	.glyph { width: 14px; height: 14px; display: block; flex: none; color: var(--text-dim); overflow: visible; }
	.bars-wrap { display: inline-flex; align-items: center; gap: 3px; height: 8px; }
	.bar-col { display: flex; flex-direction: column; justify-content: center; gap: 2px; width: 24px; height: 8px; flex: none; }
	.bars-wrap.multi .bar-col { width: 16px; }
	.bar-track { width: 100%; height: 3px; border-radius: 1.5px; background: var(--border-strong); overflow: hidden; }
	.bar-track.solo { height: 4px; border-radius: 2px; }
	.bar-track.unknown { opacity: 0.45; }
	.bar-fill { height: 100%; min-width: 2px; border-radius: inherit; background: var(--accent); transition: width var(--motion-normal) var(--ease-std); }
	.bar-fill.ok { background: var(--ok); }
	.bar-fill.warn { background: var(--warn); }
	.bar-fill.danger { background: var(--danger); }
	.badge { position: absolute; right: 2px; top: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 1.5px var(--bg); }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	/* The popover lives outside this component's DOM position (portal), so its rules are global-by-class. */
	:global(.qm-pop) {
		position: fixed; top: 0; left: 0; z-index: var(--z-tooltip); box-sizing: border-box;
		min-width: min(264px, calc(100vw - 16px)); max-width: min(320px, calc(100vw - 16px)); overflow-y: auto;
		padding: 10px 12px; border-radius: var(--radius); border: 1px solid var(--border-strong);
		background: var(--bg-elev); color: var(--text); box-shadow: var(--shadow);
		font-size: var(--fs-xs); line-height: 16px; text-align: left; white-space: normal;
		transform-origin: top center; animation: qm-pop-in var(--motion-normal) var(--ease);
	}
	:global(.qm-pop.above) { transform-origin: bottom center; animation-name: qm-pop-in-up; }
	@keyframes qm-pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.96); } to { opacity: 1; transform: none; } }
	@keyframes qm-pop-in-up { from { opacity: 0; transform: translateY(4px) scale(0.96); } to { opacity: 1; transform: none; } }
	@media (prefers-reduced-motion: reduce) { :global(.qm-pop) { animation: none; } :global(.qm-pop .pop-fill), .bar-fill { transition: none !important; } }
	:global(.qm-pop .pop-title) { font-weight: 600; font-size: var(--fs-sm); line-height: 20px; padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
	:global(.qm-pop .pop-updated) { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-size: var(--fs-2xs); line-height: 16px; font-variant-numeric: tabular-nums; color: var(--text-faint); }
	:global(.qm-pop .pop-updated.stale) { color: var(--warn); }
	:global(.qm-pop .pop-group) { margin: 8px 0 6px; font-size: var(--fs-2xs); line-height: 16px; font-weight: 600; letter-spacing: 0.02em; color: var(--text-faint); overflow-wrap: anywhere; }
	:global(.qm-pop .pop-group:first-child) { margin-top: 0; }
	:global(.qm-pop .pop-group.divider) { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
	:global(.qm-pop .pop-tier-head) { display: grid; grid-template-columns: minmax(0, 1fr) 78px; align-items: baseline; gap: 8px; margin: 8px 0 4px; padding-top: 6px; border-top: 1px dashed var(--border); font-size: var(--fs-2xs); line-height: 16px; font-weight: 500; color: var(--text-faint); }
	:global(.qm-pop .pop-tier-cols) { display: grid; grid-template-columns: 36px 36px; gap: 6px; text-align: right; white-space: nowrap; }
	:global(.qm-pop .pop-row) { margin: 0 0 6px; }
	:global(.qm-pop .pop-body > .pop-row:last-child) { margin-bottom: 0; }
	:global(.qm-pop .pop-row.divider) { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
	:global(.qm-pop .pop-row:not(.sub) .pop-label) { font-weight: 600; color: var(--text); }
	:global(.qm-pop .pop-row:not(.sub) .pop-value) { font-weight: 600; color: var(--text); }
	:global(.qm-pop .pop-row:not(.sub) .pop-value.unknown) { font-weight: 400; color: var(--text-faint); }
	:global(.qm-pop .pop-row.sub) { margin: 0 0 0 2px; padding: 2px 0 2px 9px; border-left: 1px solid var(--border); }
	:global(.qm-pop .pop-row.sub.tier-dual) { margin: 0 0 2px; padding: 0; border-left: 0; }
	:global(.qm-pop .pop-row.summary + .pop-row.sub) { margin-top: -2px; }
	:global(.qm-pop .pop-row.sub .pop-label) { color: var(--text-dim); font-size: var(--fs-2xs); line-height: 16px; }
	:global(.qm-pop .pop-row.sub .pop-track) { height: 4px; }
	:global(.qm-pop .pop-row.sub .pop-value),
	:global(.qm-pop .pop-row.sub .pop-val) { font-size: var(--fs-2xs); line-height: 16px; color: var(--text-dim); }
	:global(.qm-pop .pop-line) { display: grid; grid-template-columns: minmax(0, 1fr) 76px auto; align-items: center; gap: 8px; }
	:global(.qm-pop .pop-tier-line) { display: grid; grid-template-columns: minmax(0, 1fr) 78px; align-items: center; gap: 8px; }
	:global(.qm-pop .pop-tier-vals) { display: grid; grid-template-columns: 36px 36px; gap: 6px; align-items: center; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
	:global(.qm-pop .pop-label) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
	:global(.qm-pop .pop-value) { flex: none; min-width: 34px; font-variant-numeric: tabular-nums; color: var(--text-dim); text-align: right; white-space: nowrap; }
	:global(.qm-pop .pop-value.unknown) { color: var(--text-faint); }
	:global(.qm-pop .pop-row .pop-value.warn),
	:global(.qm-pop .pop-row .pop-val.warn) { color: var(--warn); }
	:global(.qm-pop .pop-row .pop-value.danger),
	:global(.qm-pop .pop-row .pop-val.danger) { color: var(--danger); }
	:global(.qm-pop .pop-row .pop-val.unknown) { color: var(--text-faint); }
	:global(.qm-pop .pop-track) { height: 5px; border-radius: var(--radius-pill); overflow: hidden; background: var(--border-strong); }
	:global(.qm-pop .pop-track.unknown) { opacity: 0.45; }
	:global(.qm-pop .pop-fill) { height: 100%; min-width: 3px; border-radius: var(--radius-pill); background: var(--accent); transition: width var(--motion-normal) var(--ease-std); }
	:global(.qm-pop .pop-fill.ok) { background: var(--ok); }
	:global(.qm-pop .pop-fill.warn) { background: var(--warn); }
	:global(.qm-pop .pop-fill.danger) { background: var(--danger); }
	:global(.qm-pop .pop-caption) { margin-top: 2px; font-size: var(--fs-2xs); line-height: 16px; color: var(--text-dim); overflow-wrap: anywhere; }
</style>
