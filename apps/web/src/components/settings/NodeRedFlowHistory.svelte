<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    captureNodeRedFlowRevision,
    confirmNodeRedFlowRestore,
    getNodeRedFlowRevisions,
    prepareNodeRedFlowRestore,
    type NodeRedFlowRevision,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let revisions = $state<NodeRedFlowRevision[]>([]);
  let truncated = $state(false);
  let loaded = $state(false);
  let busy = $state(false);
  let message = $state("");
  let pending = $state<{
    id: string;
    at: string | null;
    warning: string;
    action: Awaited<ReturnType<typeof prepareNodeRedFlowRestore>>["action"];
  } | null>(null);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

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

  async function prepareRestore(id: string): Promise<void> {
    busy = true;
    message = "";
    try {
      const prepared = await prepareNodeRedFlowRestore(id);
      pending = {
        id,
        at: revisions.find((row) => row.id === id)?.at ?? null,
        warning: prepared.warning,
        action: prepared.action,
      };
      expired = false;
      clearTimeout(timer);
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, prepared.action.expiresAt - Date.now()),
      );
    } catch (error) {
      message =
        error instanceof Error ? error.message : "Herstel niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function confirmRestore(approve: boolean): Promise<void> {
    const selected = pending;
    if (!selected) return;
    busy = true;
    try {
      const result = await confirmNodeRedFlowRestore(
        selected.id,
        selected.action.sessionId,
        selected.action.confirmationId,
        approve,
      );
      if (!result.ok) throw new Error(result.error);
      pending = null;
      clearTimeout(timer);
      if (!approve || "cancelled" in result) {
        message = "Flowherstel geannuleerd.";
        return;
      }
      await load();
      message =
        result.revision.historyWarning ??
        "Node-RED-flows hersteld en gecontroleerd.";
    } catch (error) {
      message =
        error instanceof Error ? error.message : "Flowherstel is mislukt.";
      pending = null;
      clearTimeout(timer);
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
              <Button
                disabled={busy || pending !== null}
                onclick={() => prepareRestore(revision.id)}
                >Deze versie herstellen</Button
              >
            {/if}
          </li>
        {/each}
      </ul>
      {#if truncated}<small>Alleen de tien recentste versies getoond.</small
        >{/if}
      {#if pending}
        <div role="group" aria-label="Flowherstel bevestigen">
          <p>{pending.warning}</p>
          <p>
            De huidige flows worden vervangen door de versie van {pending.at
              ? new Date(pending.at).toLocaleString("nl-NL")
              : "eerder"}.
          </p>
          {#if expired}<p role="status">
              Bevestiging verlopen. Kies opnieuw.
            </p>{/if}
          <Button
            disabled={busy || expired}
            onclick={() => confirmRestore(true)}>Herstel bevestigen</Button
          >
          <Button disabled={busy} onclick={() => confirmRestore(false)}
            >Annuleren</Button
          >
        </div>
      {/if}
    {:else}<p>Nog geen flowversies opgeslagen.</p>{/if}
  {/if}
</section>
