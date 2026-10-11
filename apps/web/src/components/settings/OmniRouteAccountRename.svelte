<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteAccountRenameHistoryEntry,
    OmniRouteAccountRenamePrepared,
    OmniRouteAccountRenameResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    confirmOmniRouteAccountRename,
    getOmniRouteAccountRenameHistory,
    prepareOmniRouteAccountRename,
    prepareOmniRouteAccountRenameRollback,
  } from "#lib/api/settings.ts";

  let {
    id,
    provider,
    initialName,
    done,
  }: {
    id: string;
    provider: string;
    initialName: string;
    done: (result?: OmniRouteAccountRenameResult) => void;
  } = $props();
  let editing = $state(false);
  let name = $state("");
  let busy = $state(false);
  let error = $state("");
  let pending = $state<OmniRouteAccountRenamePrepared | null>(null);
  let expired = $state(false);
  let acknowledged = $state(false);
  let history = $state<OmniRouteAccountRenameHistoryEntry[]>([]);
  let historyLoaded = $state(false);
  let historyBusy = $state(false);
  let isRollback = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  async function loadHistory() {
    historyBusy = true;
    error = "";
    try {
      history = (await getOmniRouteAccountRenameHistory(id)).revisions;
      historyLoaded = true;
    } catch {
      error = "Accountgeschiedenis kon niet worden geladen.";
    } finally {
      historyBusy = false;
    }
  }

  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountRename(id, name, true);
      if (!result.ok || !result.action) {
        error = result.error || "Accountnaam kon niet worden voorbereid.";
        return;
      }
      pending = result;
      isRollback = false;
      expired = false;
      acknowledged = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error = "Accountnaam kon niet worden voorbereid. Controleer je PIN.";
    } finally {
      busy = false;
    }
  }

  async function prepareRollback(revisionId: string) {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountRenameRollback(
        id,
        revisionId,
        true,
      );
      if (!result.ok || !result.action) {
        error = result.error || "Herstel kon niet worden voorbereid.";
        return;
      }
      pending = result;
      isRollback = true;
      expired = false;
      acknowledged = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error = "Herstel kon niet worden voorbereid. Controleer je PIN.";
    } finally {
      busy = false;
    }
  }

  async function confirm(approve: boolean) {
    const action = pending?.action;
    if (!action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmOmniRouteAccountRename(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) error = result.error || "Accountnaam is niet gewijzigd.";
      else if (!approve) {
        editing = false;
        done();
      } else if (result.verified === true) {
        editing = false;
        await loadHistory();
        done(result);
      } else {
        error =
          "Uitkomst niet gecontroleerd. Controleer de accountnaam in OmniRoute.";
      }
    } catch {
      error = "Uitkomst niet gecontroleerd. Controleer OmniRoute.";
    } finally {
      pending = null;
      clearTimeout(timer);
      busy = false;
    }
  }
</script>

<section aria-label={`Accountnaam wijzigen ${provider}`}>
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending}
    <p>
      {isRollback ? "Herstellen:" : "Wijzigen:"}
      <strong>{pending.oldName}</strong> → <strong>{pending.newName}</strong> · {pending.provider}
    </p>
    <p>
      De naam is zichtbaar voor alle OmniRoute-clients. Als Cloud-sync aanstaat,
      kan OmniRoute de wijziging ook synchroniseren met OmniRoute Cloud.
    </p>
    <label>
      <input type="checkbox" bind:checked={acknowledged} /> Ik begrijp dat de naamswijziging
      alle OmniRoute-clients raakt en mogelijk naar OmniRoute Cloud wordt gesynchroniseerd.
    </label>
    {#if expired}<p role="status">
        Bevestiging verlopen. Bereid de wijziging opnieuw voor.
      </p>{/if}
    <Button
      onclick={() => confirm(true)}
      disabled={busy || expired || !acknowledged}>Naam wijzigen</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {:else if editing}
    <label>
      Nieuwe accountnaam
      <input
        bind:value={name}
        maxlength="200"
        autocomplete="off"
        disabled={busy}
      />
    </label>
    <Button onclick={prepare} disabled={busy || !name.trim()}
      >Controleren</Button
    >
    <Button
      onclick={() => {
        editing = false;
        error = "";
      }}
      disabled={busy}>Annuleren</Button
    >
  {:else}
    <Button
      onclick={() => {
        name = initialName;
        editing = true;
        error = "";
      }}
      disabled={busy}>Naam wijzigen</Button
    >
    <Button onclick={loadHistory} disabled={busy || historyBusy}>
      {historyBusy ? "Geschiedenis laden…" : "Geschiedenis laden"}
    </Button>
    {#if historyLoaded}
      {#if history.length}
        <ol aria-label={`Naamgeschiedenis ${provider}`}>
          {#each history as revision, index (revision.id)}
            <li>
              <span>{revision.beforeName} → {revision.afterName}</span>
              <time datetime={revision.at}
                >{new Date(revision.at).toLocaleString("nl-NL")}</time
              >
              {#if index === 0}
                <Button
                  onclick={() => prepareRollback(revision.id)}
                  disabled={busy}>Nieuwste wijziging herstellen</Button
                >
              {/if}
            </li>
          {/each}
        </ol>
      {:else}<p>Geen naamswijzigingen opgeslagen.</p>{/if}
    {/if}
  {/if}
</section>
