<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import {
    captureNodeRedFlowRevision,
    exportNodeRedFlows,
    getNodeRedFlowRevisions,
    restoreNodeRedFlowRevision,
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
        error instanceof ApiError ? error.message : "Versies niet beschikbaar.";
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
        error instanceof ApiError
          ? error.message
          : "Flowversie opslaan is mislukt.";
    } finally {
      busy = false;
    }
  }

  async function download(): Promise<void> {
    busy = true;
    try {
      const data = await exportNodeRedFlows();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `nova-node-red-flows-${new Date().toISOString().slice(0, 10)}.json`;
      try {
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      message =
        "Flowexport gedownload. Controleer het bestand vóór opslag in een repo.";
    } catch (error) {
      message =
        error instanceof ApiError ? error.message : "Flowexport mislukt.";
    } finally {
      busy = false;
    }
  }

  async function restore(id: string): Promise<void> {
    busy = true;
    message = "";
    try {
      const result = await restoreNodeRedFlowRevision(id);
      if (!result.ok) throw new Error(result.error);
      await load();
      message =
        result.revision.historyWarning ??
        "Node-RED-flows hersteld en gecontroleerd.";
    } catch (error) {
      message =
        error instanceof ApiError ? error.message : "Flowherstel is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="Node-RED-versiegeschiedenis">
  <h4>Lokale flowversies</h4>
  <p class="hint">
    Bewaart op verzoek en na gecontroleerde wijzigingen een privé momentopname
    van de Node-RED-flows. Alleen datum en nodeaantal staan op het scherm;
    node-inhoud blijft op de server.
  </p>
  <Button disabled={busy} onclick={load}>Versies laden</Button>
  <Button disabled={busy} onclick={capture}>Huidige versie bewaren</Button>
  <Button disabled={busy} onclick={download}>Flows downloaden</Button>
  {#if message}<p role="status">{message}</p>{/if}
  {#if loaded}
    {#if revisions.length}
      <ul>
        {#each revisions as revision, index (revision.id)}
          <li>
            <time datetime={revision.at}
              >{new Date(revision.at).toLocaleString("nl-NL")}</time
            >
            · {revision.nodeCount} nodes
            {#if index > 0}
              <Button disabled={busy} onclick={() => restore(revision.id)}
                >Herstel deze versie</Button
              >
            {/if}
          </li>
        {/each}
      </ul>
      {#if truncated}<small>Alleen de tien recentste versies getoond.</small
        >{/if}
    {:else}<p>Nog geen flowversies opgeslagen.</p>{/if}
  {/if}
</section>
