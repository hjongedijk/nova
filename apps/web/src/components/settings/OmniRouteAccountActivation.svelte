<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteActivationHistoryEntry,
    OmniRouteAccountActivationPrepared,
    OmniRouteAccountActivationResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    prepareOmniRouteAccountActivation,
    confirmOmniRouteAccountActivation,
    getOmniRouteAccountActivationHistory,
    prepareOmniRouteAccountActivationRollback,
  } from "#lib/api/settings.ts";
  let {
    id,
    name,
    enabled,
    done,
  }: {
    id: string;
    name: string;
    enabled: boolean;
    done: (result?: OmniRouteAccountActivationResult) => void;
  } = $props();
  let busy = $state(false);
  let pending = $state<OmniRouteAccountActivationPrepared | null>(null);
  let error = $state("");
  let expired = $state(false);
  let history = $state<OmniRouteActivationHistoryEntry[] | null>(null);
  let historyBusy = $state(false);
  let historyError = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountActivation(id, !enabled);
      if (!result.ok || !result.action) {
        error = result.error || "Accountwijziging kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error = "Accountwijziging kon niet worden voorbereid. Controleer je PIN.";
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
      const result = await confirmOmniRouteAccountActivation(
        id,
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok)
        error =
          result.error || "Accountwijziging kon niet worden gecontroleerd.";
      else if (!approve || result.verified === true) {
        done(approve ? result : undefined);
        if (approve) await loadHistory();
      } else
        error =
          "Uitkomst onbekend. Controleer OmniRoute en het gratis routebeleid.";
    } catch {
      error =
        "Uitkomst onbekend. Controleer OmniRoute en het gratis routebeleid.";
    } finally {
      pending = null;
      clearTimeout(timer);
      busy = false;
    }
  }
  async function loadHistory() {
    historyBusy = true;
    historyError = "";
    try {
      history = (await getOmniRouteAccountActivationHistory(id)).revisions;
    } catch {
      historyError = "Accountgeschiedenis kon niet worden geladen.";
    } finally {
      historyBusy = false;
    }
  }
  async function prepareRollback(revision: string) {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountActivationRollback(
        id,
        revision,
      );
      if (!result.ok || !result.action) {
        error = result.error || "Herstel kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
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
</script>

<div
  class="activation"
  role="group"
  aria-label="Provideraccount in- of uitschakelen"
>
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending?.action}
    <p>Provideraccount: {pending.name || name}</p>
    <p>Dit wijzigt het account voor alle OmniRoute-clients.</p>
    <p>
      NOVA blokkeert AI tijdens de wijziging en controleert de status in
      OmniRoute en lokaal.
    </p>
    <p>Bevestiging verloopt na 60 seconden en is eenmalig.</p>
    {#if expired}<p role="status">Bevestiging verlopen. Start opnieuw.</p>{/if}
    <Button onclick={() => confirm(true)} disabled={busy || expired}
      >Bevestig {pending.enabled ? "inschakelen" : "uitschakelen"}</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {:else}
    <Button onclick={prepare} disabled={busy}>
      {enabled ? "Account uitschakelen" : "Account inschakelen"}
    </Button>
    <Button onclick={loadHistory} disabled={historyBusy || busy}>
      {historyBusy ? "Geschiedenis laden…" : "Wijzigingsgeschiedenis"}
    </Button>
  {/if}
  {#if historyError}<p role="status">{historyError}</p>{/if}
  {#if history}
    {#if history.length}
      <ol aria-label={`Geschiedenis ${name}`}>
        {#each history as revision, index (revision.id)}
          <li>
            <time datetime={revision.at}
              >{new Date(revision.at).toLocaleString("nl-NL")}</time
            >
            — {revision.beforeEnabled ? "actief" : "uit"} →
            {revision.afterEnabled ? "actief" : "uit"}
            {#if index === 0}
              <Button
                disabled={busy || pending !== null}
                onclick={() => prepareRollback(revision.id)}>Herstel</Button
              >
            {:else}<span>Alleen de nieuwste wijziging kan worden hersteld.</span
              >{/if}
          </li>
        {/each}
      </ol>
    {:else}<p>Geen accountwijzigingen opgeslagen.</p>{/if}
  {/if}
</div>

<style>
  .activation {
    border: 1px solid var(--color-warning, #ff8a33);
    padding: 1rem;
    margin-block: 0.5rem;
  }
  :global(.activation button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
