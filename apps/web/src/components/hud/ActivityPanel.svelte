<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";
  import { ago, toolLabel } from "#lib/util/format.ts";

  const rows = $derived(dashboard.activity);
</script>

<section class="hud" data-panel="activiteit" aria-label="Activiteit">
  <h2>Activiteit</h2>
  <ul>
    {#each rows as entry, i (i)}
      <li class={entry.result?.ok === false ? "bad" : "ok"}>
        <i></i>
        <span>{toolLabel(entry.tool ?? "")}</span>
        <time datetime={entry.timestamp}>{ago(entry.timestamp)}</time>
      </li>
    {/each}
  </ul>
  <p class="empty">{rows.length ? "" : "Nog geen acties."}</p>
</section>
