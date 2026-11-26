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
			<Ring {gauge} strings={data.strings} />
		{/each}
	</div>
{/if}

<style>
	.qm { display: flex; align-items: center; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; overscroll-behavior-x: contain; }
	.qm::-webkit-scrollbar { display: none; }
	/* Header (desktop): compact tile strip that yields to the header title. */
	.qm.header { flex: 0 1 auto; gap: 4px; max-width: min(48%, 230px); padding: 2px 4px; }
	/* Sidebar top (mobile ≤600px): single compact row right below the logo bar with evenly distributed tiles. */
	.qm.sidebar { flex: none; justify-content: space-around; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); }
</style>
