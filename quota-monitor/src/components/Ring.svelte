<script module>
	let seq = 0;
	// Only one detail popover may be visible at a time.
	let closeActive = null;
</script>

<script>
	let { gauge, strings } = $props();

	const WIDTH = 2.4, FIRST = 16, STEP = 3.4, NAMED = ["accent", "ok", "warn", "danger"];
	const OPEN_DELAY = 80, CLOSE_DELAY = 120, MARGIN = 8, GAP = 6;
	const fill = (text, params) => String(text ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));

	const meter = (item) => {
		const max = item.max ?? 100;
		const known = item.value !== null && item.value !== undefined;
		const ratio = known ? Math.min(Math.max(item.value / max, 0), 1) : 0;
		const color = item.color ?? "accent";
		return { known, ratio, named: NAMED.includes(color) ? color : "", hex: NAMED.includes(color) ? undefined : color, max };
	};
	const rings = $derived(gauge.rings.map((ring, index) => {
		const m = meter(ring);
		return { ...m, radius: FIRST - index * STEP, dash: `${(m.ratio * 100).toFixed(3)} 100`, label: ring.label ?? gauge.label, value: ring.value, text: m.known ? `${Math.round(m.ratio * 100)}%` : strings.unknown };
	}));
	const innerRadius = $derived(rings.at(-1).radius);
	const iconSide = $derived((innerRadius - WIDTH / 2 - 1.5) * 1.4142);
	const iconPos = $derived(18 - iconSide / 2);
	const details = $derived(gauge.details);
	const updatedAt = $derived(details?.updatedAt);
	const rows = $derived((details?.rows ?? []).map((row, index, all) => {
		const m = meter(row);
		return { ...m, heading: row.group !== undefined && row.group !== all[index - 1]?.group ? row.group : undefined, label: row.label, caption: row.caption, percent: (m.ratio * 100).toFixed(2), text: m.known ? `${Math.round(m.ratio * 100)}%` : strings.unknown };
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
	const summary = $derived(rows.map((r) => `${r.label}: ${r.text}`).join(", "));
	const description = $derived([gauge.hint, gauge.stale && updatedAt === undefined ? strings.stale : "", details ? [details.title, summary].filter(Boolean).join(": ") : ""].filter(Boolean).join(". ") || undefined);

	const popId = `quota-detail-${++seq}`;
	let el = $state();
	let popEl = $state();
	let open = $state(false);
	let placement = $state("below");
	let timer;
	let pointerDown = false;

	const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
	function show() {
		clear();
		if (!details || open) return;
		if (closeActive && closeActive !== hide) closeActive();
		closeActive = hide;
		open = true;
	}
	function hide() {
		clear();
		open = false;
		if (closeActive === hide) closeActive = null;
	}
	const later = (action, delay) => { clear(); timer = setTimeout(action, delay); };
	function place() {
		if (!el || !popEl) return;
		const rect = el.getBoundingClientRect();
		const vw = document.documentElement.clientWidth, vh = window.innerHeight;
		const width = popEl.offsetWidth, height = popEl.offsetHeight;
		const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, MARGIN), Math.max(MARGIN, vw - width - MARGIN));
		const below = rect.bottom + GAP, above = rect.top - GAP - height;
		const flip = !(below + height <= vh - MARGIN) && (above >= MARGIN || rect.top > vh - rect.bottom);
		placement = flip ? "above" : "below";
		const top = flip ? Math.max(MARGIN, above) : below;
		popEl.style.left = `${Math.round(left)}px`;
		popEl.style.top = `${Math.round(top)}px`;
		popEl.style.maxHeight = `${Math.max(80, vh - top - MARGIN)}px`;
		popEl.style.visibility = "visible";
	}
	// Out of the header so its overflow cannot clip the popover; inside an open <dialog> (top layer) when there is one.
	function portal(node) {
		(el?.closest("dialog") ?? document.body).appendChild(node);
		return { destroy: () => node.remove() };
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
	<div class="circle">
		<svg class="rings" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
			{#each rings as ring}
				<circle class="track" cx="18" cy="18" r={ring.radius} />
				{#if ring.known}
					<circle class="arc {ring.named}" cx="18" cy="18" r={ring.radius} pathLength="100" style:stroke={ring.hex} stroke-dasharray={ring.dash} />
				{:else}
					<circle class="unknown" cx="18" cy="18" r={ring.radius} />
				{/if}
			{/each}
			{#if gauge.icon}
				<svg x={iconPos} y={iconPos} width={iconSide} height={iconSide} viewBox={gauge.icon.viewBox} class="glyph">
					{#each gauge.icon.paths as path}
						<path d={path.d} fill={path.fill ?? "currentColor"} fill-rule={path.fillRule ?? "nonzero"} />
					{/each}
				</svg>
			{/if}
		</svg>
		{#if gauge.stale}<span class="badge" aria-hidden="true">!</span>{/if}
		{#each rings as ring}
			<span class="sr-only" role="progressbar" aria-label={ring.label} aria-valuemin="0" aria-valuemax={ring.max} aria-valuenow={ring.known ? ring.value : undefined} aria-valuetext={ring.text}></span>
		{/each}
	</div>
</div>

{#if open && details}
	<div use:portal bind:this={popEl} id={popId} class="qm-pop {placement}" role="tooltip" style="visibility: hidden" onpointerenter={clear} onpointerleave={(e) => { if (hovering(e)) later(hide, CLOSE_DELAY); }}>
		{#if details.title}<div class="pop-title">{details.title}</div>{/if}
		{#if gauge.stale && updatedAt === undefined}<div class="pop-stale">{strings.stale}</div>{/if}
		{#each rows as row}
			{#if row.heading}<div class="pop-group">{row.heading}</div>{/if}
			<div class="pop-row">
				<div class="pop-line">
					<span class="pop-label">{row.label}</span>
					<span class="pop-value" class:unknown={!row.known}>{row.text}</span>
				</div>
				<div class="pop-track" class:unknown={!row.known}>
					{#if row.known}<div class="pop-fill {row.named}" style:width="{row.percent}%" style:background={row.hex}></div>{/if}
				</div>
				{#if row.caption}<div class="pop-caption">{row.caption}</div>{/if}
			</div>
		{/each}
		{#if updatedText}<div class="pop-updated" class:stale={gauge.stale}>{updatedText}</div>{/if}
	</div>
{/if}

<style>
	.gauge { position: relative; display: inline-flex; align-items: center; flex: none; max-width: 100%; border-radius: 6px; -webkit-tap-highlight-color: transparent; }
	.gauge:focus:not(:focus-visible) { outline: none; }
	.gauge:focus-visible { outline: 1.5px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
	.gauge.stale { opacity: 0.65; }
	.circle { position: relative; flex: none; width: 26px; height: 26px; }
	.rings { display: block; width: 100%; height: 100%; overflow: visible; }
	circle { fill: none; stroke-width: 2.4; }
	.track { stroke: var(--border-strong); }
	.arc { stroke: var(--accent); transform: rotate(-90deg); transform-origin: 18px 18px; }
	.arc.accent { stroke: var(--accent); }
	.arc.ok { stroke: var(--ok); }
	.arc.warn { stroke: var(--warn); }
	.arc.danger { stroke: var(--danger); }
	.unknown { stroke: var(--text-faint); stroke-dasharray: 2 4; }
	.glyph { color: var(--text-dim); overflow: hidden; }
	.badge { position: absolute; right: 0; top: 0; width: 9px; height: 9px; line-height: 9px; text-align: center; border-radius: 50%; font-size: 7px; overflow: hidden; color: var(--bg); background: var(--warn); }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
	@media (max-width: 600px) { .circle { width: 22px; height: 22px; } }
	/* The popover lives outside this component's DOM position (portal), so its rules are global-by-class. */
	:global(.qm-pop) {
		position: fixed; top: 0; left: 0; z-index: var(--z-tooltip); box-sizing: border-box;
		min-width: min(240px, calc(100vw - 16px)); max-width: min(320px, calc(100vw - 16px)); overflow-y: auto;
		padding: 10px 12px; border-radius: var(--radius); border: 1px solid var(--border-strong);
		background: var(--bg-elev); color: var(--text); box-shadow: var(--shadow);
		font-size: var(--fs-xs); line-height: 1.4; text-align: left; white-space: normal;
		transform-origin: top center; animation: qm-pop-in var(--motion-normal) var(--ease);
	}
	:global(.qm-pop.above) { transform-origin: bottom center; }
	@keyframes qm-pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.96); } to { opacity: 1; transform: none; } }
	@media (prefers-reduced-motion: reduce) { :global(.qm-pop) { animation: none; } :global(.qm-pop .pop-fill) { transition: none !important; } }
	:global(.qm-pop .pop-title) { font-weight: 600; font-size: var(--fs-sm); margin-bottom: 6px; overflow-wrap: anywhere; }
	:global(.qm-pop .pop-stale) { margin-bottom: 6px; padding: 2px 6px; border-radius: 5px; font-size: var(--fs-2xs); color: var(--warn); background: var(--warn-soft); }
	:global(.qm-pop .pop-updated) { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border-strong); font-size: var(--fs-2xs); font-variant-numeric: tabular-nums; color: var(--text-faint); }
	:global(.qm-pop .pop-updated.stale) { color: var(--warn); }
	:global(.qm-pop .pop-group) { margin: 8px 0 4px; font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.02em; color: var(--text-faint); overflow-wrap: anywhere; }
	:global(.qm-pop .pop-group:first-child) { margin-top: 0; }
	:global(.qm-pop .pop-row) { margin: 0 0 8px; }
	:global(.qm-pop .pop-row:last-child) { margin-bottom: 0; }
	:global(.qm-pop .pop-line) { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 3px; }
	:global(.qm-pop .pop-label) { min-width: 0; overflow-wrap: anywhere; color: var(--text); }
	:global(.qm-pop .pop-value) { flex: none; font-variant-numeric: tabular-nums; color: var(--text-dim); text-align: right; }
	:global(.qm-pop .pop-value.unknown) { color: var(--text-faint); }
	:global(.qm-pop .pop-track) { height: 6px; border-radius: var(--radius-pill); overflow: hidden; background: var(--border-strong); }
	:global(.qm-pop .pop-track.unknown) { background: transparent; border: 1px dashed var(--text-faint); opacity: 0.6; box-sizing: border-box; }
	:global(.qm-pop .pop-fill) { height: 100%; border-radius: var(--radius-pill); background: var(--accent); transition: width var(--motion-normal) var(--ease-std); }
	:global(.qm-pop .pop-fill.ok) { background: var(--ok); }
	:global(.qm-pop .pop-fill.warn) { background: var(--warn); }
	:global(.qm-pop .pop-fill.danger) { background: var(--danger); }
	:global(.qm-pop .pop-caption) { margin-top: 2px; font-size: var(--fs-2xs); color: var(--text-dim); overflow-wrap: anywhere; }
</style>
