<script lang="ts">
  import { onMount } from "svelte";
  import type { ServiceConnectionRevision } from "@nova/contracts";
  import {
    getConnectionHistory,
    getServiceConnections,
    rollbackConnection,
  } from "#lib/api/settings.ts";
  import { fail, say } from "./state.svelte.ts";
  let revisions = $state<ServiceConnectionRevision[]>([]);
  let names = $state<Record<string, string>>({});
  let labels = $state<Record<string, Record<string, string>>>({});
  let busy = $state(false);
  async function load() {
    try {
      const [history, connections] = await Promise.all([
        getConnectionHistory(),
        getServiceConnections(),
      ]);
      revisions = history.revisions;
      names = Object.fromEntries(
        connections.services.map((item) => [item.id, item.label]),
      );
      labels = Object.fromEntries(
        connections.services.map((item) => [
          item.id,
          Object.fromEntries(
            item.fields.map((field) => [field.key, field.label]),
          ),
        ]),
      );
    } catch (e) {
      fail(e);
    }
  }
  onMount(() => {
    void load();
  });
  async function undo(id: string) {
    busy = true;
    try {
      const result = await rollbackConnection(id);
      await load();
      say(
        result.auditWarning ??
          "De eerdere verbindingsinstellingen zijn opgeslagen. Herstart NOVA om ze toe te passen.",
        result.auditWarning ? "bad" : "ok",
      );
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }
</script>

<h2>Wijzigingen aan koppelingen</h2>
<p class="hint">
  Geheime waarden staan nooit in de geschiedenis. Voor een eerdere sleutel vul
  je die zelf opnieuw in bij de koppeling.
</p>
<ul class="set-list">
  {#each revisions as revision (revision.id)}
    <li class="connection-revision">
      <strong>{names[revision.service] ?? "Koppeling"}</strong><time
        datetime={revision.at}
        >{new Date(revision.at).toLocaleString("nl-NL")}</time
      >
      <details>
        <summary>Wat is veranderd?</summary>
        {#each Object.entries(revision.after).filter(([key, value]) => revision.before[key] !== value) as [key, value] (key)}
          <p>
            {labels[revision.service]?.[key] ?? "Instelling"}: {typeof revision
              .before[key] === "boolean"
              ? revision.before[key]
                ? "Aan"
                : "Uit"
              : String(revision.before[key] ?? "")} → {typeof value ===
            "boolean"
              ? value
                ? "Aan"
                : "Uit"
              : String(value)}
          </p>
        {/each}
        {#if revision.secretChanges.length}<p>
            Geheime velden vervangen of gewist.
          </p>{/if}
      </details>
      {#if !revision.secretChanges.length}<button
          type="button"
          disabled={busy}
          onclick={() => undo(revision.id)}>Deze wijziging terugdraaien</button
        >{/if}
    </li>
  {:else}<li class="hint">Nog geen wijzigingen aan koppelingen.</li>{/each}
</ul>

<style>
  .connection-revision {
    padding: 16px 0;
    border-bottom: 1px solid var(--line);
    overflow-wrap: anywhere;
  }
  .connection-revision time {
    display: block;
    color: var(--dim);
    font-size: 12px;
  }
  .connection-revision button {
    padding: 9px 12px;
    border: 1px solid var(--line);
    background: #112338;
    color: var(--mist);
    font: inherit;
    cursor: pointer;
  }
</style>
