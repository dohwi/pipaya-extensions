<script>
	// Draws the quota gauges. The worker polls and sends plain data (`sdk.components.setData`); this only draws it.
	import { ext } from "pipaya";
	import Ring from "./Ring.svelte";
	const data = $derived(ext.data);
	const items = $derived(data?.view?.children ?? []);
</script>

{#if items.length}
	<div class="qm" role="group" aria-label={data.label}>
		{#each items as gauge (gauge.id)}
			<Ring {gauge} strings={data.strings} />
		{/each}
	</div>
{/if}

<style>
	/* Yields to the header title like the built-in navbar: capped, clipped instead of growing. */
	.qm { display: flex; align-items: center; flex: 0 1 auto; gap: 6px; min-width: 0; max-width: min(40%, 160px); overflow-x: auto; overflow-y: hidden; scrollbar-width: none; padding: 2px 3px; overscroll-behavior-x: contain; }
	.qm::-webkit-scrollbar { display: none; }
	@media (max-width: 600px) { .qm { max-width: min(36%, 132px); gap: 4px; padding: 2px; } }
</style>
