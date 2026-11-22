<script>
	// Draws the quota gauges. The worker polls and sends plain data (`sdk.components.setData`); this only draws it.
	import { ext } from "pipaya";
	import Ring from "./Ring.svelte";
	const data = $derived(ext.data);
	const items = $derived(data?.gauges ?? []);
</script>

{#if items.length}
	<div class="qm" role="group" aria-label={data.label}>
		{#each items as gauge (gauge.id)}
			<Ring {gauge} strings={data.strings} />
		{/each}
	</div>
{/if}

<style>
	/* Yields to the header title: capped, clipped instead of growing. */
	.qm { display: flex; align-items: center; flex: 0 1 auto; gap: 6px; min-width: 0; max-width: min(44%, 192px); overflow-x: auto; overflow-y: hidden; scrollbar-width: none; padding: 3px 4px; overscroll-behavior-x: contain; }
	.qm::-webkit-scrollbar { display: none; }
	@media (max-width: 600px) { .qm { max-width: min(40%, 148px); gap: 4px; padding: 3px; } }
</style>
