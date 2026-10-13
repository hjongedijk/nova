<script lang="ts">
  import {
    captureNodeRedFlowRevision,
    getNodeRedFlowRevisions,
    type NodeRedFlowRevision,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let revisions = $state<NodeRedFlowRevision[]>([]);
  let truncated = $state(false);
  let loaded = $state(false);
  let busy = $state(false);
  let message = $state("");

  async function load(): Promise<void> {
    busy = true;
    try {
      const result = await getNodeRedFlowRevisions();
      revisions = result.revisions;
      truncated = result.truncated;
      loaded = true;
      message = "";
    } catch (error) {
      message =
        error instanceof Error ? error.message : "Versies niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function capture(): Promise<void> {
    busy = true;
    try {
      await captureNodeRedFlowRevision();
      const result = await getNodeRedFlowRevisions();
      revisions = result.revisions;
      truncated = result.truncated;
      loaded = true;
      message = "Huidige Node-RED-flowversie privé opgeslagen.";
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "Flowversie opslaan is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="Node-RED-versiegeschiedenis">
  <h4>Lokale flowversies</h4>
  <p class="hint">
    Bewaart op verzoek een privé momentopname van de huidige Node-RED-flows.
    Alleen datum en nodeaantal staan op het scherm; node-inhoud blijft op de
    server.
  </p>
  <Button disabled={busy} onclick={load}>Versies laden</Button>
  <Button disabled={busy} onclick={capture}>Huidige versie bewaren</Button>
  {#if message}<p role="status">{message}</p>{/if}
  {#if loaded}
    {#if revisions.length}
      <ul>
        {#each revisions as revision (revision.id)}
          <li>
            <time datetime={revision.at}
              >{new Date(revision.at).toLocaleString("nl-NL")}</time
            >
            · {revision.nodeCount} nodes
          </li>
        {/each}
      </ul>
      {#if truncated}<small>Alleen de tien recentste versies getoond.</small
        >{/if}
    {:else}<p>Nog geen flowversies opgeslagen.</p>{/if}
  {/if}
</section>
