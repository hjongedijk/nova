<script lang="ts">
  import type { SkillRun } from "@nova/contracts";
  import { skillRuns } from "#lib/api/settings.ts";
  import { fail } from "./state.svelte.ts";

  let { id }: { id: string } = $props();

  let runs = $state<SkillRun[] | null>(null);

  $effect(() => {
    skillRuns(id).then(
      (data) => (runs = data.runs),
      (error) => fail(error),
    );
  });
</script>

{#if runs}
  <div class="panel">
    <strong>Recente aanroepen</strong>
    {#if runs.length}
      <ul class="runs">
        {#each runs as run, index (index)}
          <li>
            <span class={run.ok ? "ok" : "bad"}
              >{run.ok ? "gelukt" : "mislukt"}</span
            >
            <span>{new Date(run.at).toLocaleString("nl-NL")}</span>
            <span>{run.error || JSON.stringify(run.arguments)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="hint">Nog niet aangeroepen.</p>
    {/if}
  </div>
{/if}
