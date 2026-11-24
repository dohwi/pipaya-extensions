<script>
	// Draws the quota gauges. The worker polls and sends plain data (`sdk.components.setData`); this only draws it.
	import { ext } from "pipaya";
	import Ring from "./Ring.svelte";

	const MOBILE_QUERY = "(max-width: 600px)";
	let { location = "header" } = $props();

	let mobile = $state(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches);
	$effect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(MOBILE_QUERY);
		mobile = mq.matches;
		const onChange = (event) => { mobile = event.matches; };
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	});

	const data = $derived(ext.data);
	const items = $derived(data?.gauges ?? []);
	const activeLocation = $derived(mobile ? "sidebar" : "header");
	const visible = $derived(items.length > 0 && activeLocation === location);
</script>

{#if visible}
	<div class="qm {location}" role="group" aria-label={data.label}>
		{#each items as gauge (gauge.id)}
			<Ring {gauge} strings={data.strings} preferAbove={location === "sidebar"} />
		{/each}
	</div>
{/if}

<style>
	.qm { display: flex; align-items: center; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; overscroll-behavior-x: contain; }
	.qm::-webkit-scrollbar { display: none; }
	/* Header (desktop): compact ring strip that yields to the header title. */
	.qm.header { flex: 0 1 auto; gap: 6px; max-width: min(44%, 192px); padding: 3px 4px; }
	/* Sidebar bottom (mobile ≤600px): single compact row above Graph View with evenly distributed rings. */
	.qm.sidebar { --qm-ring: 26px; justify-content: space-around; gap: 8px; margin: 0 -8px 8px; padding: 4px 12px 12px; border-bottom: 1px solid var(--border); }
</style>
