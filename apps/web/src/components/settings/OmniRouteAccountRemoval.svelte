<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteAccountRemovalPrepared,
    OmniRouteAccountRemovalResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    prepareOmniRouteAccountRemoval,
    confirmOmniRouteAccountRemoval,
  } from "#lib/api/settings.ts";
  let {
    id,
    name,
    done,
  }: {
    id: string;
    name: string;
    done: (result?: OmniRouteAccountRemovalResult) => void;
  } = $props();
  let acknowledged = $state(false);
  let busy = $state(false);
  let pending = $state<OmniRouteAccountRemovalPrepared | null>(null);
  let error = $state("");
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountRemoval(id);
      if (!result.ok || !result.action) {
        error = result.error || "Verwijdering kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      timer = setTimeout(
        () => {
          expired = true;
        },
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error =
        "Verwijdering kon niet worden voorbereid. Controleer je PIN en de koppeling.";
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
      const result = await confirmOmniRouteAccountRemoval(
        id,
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok)
        error = result.error || "Verwijdering kon niet worden gecontroleerd.";
      else if (!approve || result.verified === true)
        done(approve ? result : undefined);
      else
        error =
          "Verwijdering is niet gecontroleerd. Laad het accountoverzicht opnieuw.";
    } catch {
      error =
        "Uitkomst onbekend. Het account kan al verwijderd zijn. Controleer de accounts en gratis route.";
    } finally {
      pending = null;
      acknowledged = false;
      clearTimeout(timer);
      busy = false;
    }
  }
</script>

<div class="removal" role="group" aria-label="Gateway-account verwijderen">
  <h3>Verwijder {pending?.name || name}</h3>
  <p>
    Dit verwijdert het account en gekoppelde model- en routegegevens voor alle
    OmniRoute-clients. Ingeschakelde cloudsynchronisatie verwerkt de wijziging
    ook.
  </p>
  <p>
    NOVA blokkeert AI vóór de wijziging. Alleen een opnieuw geverifieerde gratis
    route kan daarna verder.
  </p>
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending?.action}
    <p>
      Deze risicovolle verwijdering vraagt toestemming binnen 60 seconden, één
      keer geldig.
    </p>
    {#if expired}<p role="status">
        Toestemming verlopen. Annuleer en kies het account opnieuw.
      </p>{/if}
    <Button onclick={() => confirm(true)} disabled={busy || expired}
      >Bevestig accountverwijdering</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}
      >Annuleer accountverwijdering</Button
    >
  {:else}
    <label
      ><input type="checkbox" bind:checked={acknowledged} disabled={busy} />Ik
      verwijder dit account en gekoppelde gegevens voor alle gateway-clients.</label
    >
    <Button onclick={prepare} disabled={busy || !acknowledged}
      >Accountverwijdering voorbereiden</Button
    >
    <Button onclick={() => done()} disabled={busy}>Sluiten</Button>
  {/if}
</div>

<style>
  .removal {
    border: 1px solid #ff8a33;
    padding: 1rem;
    margin-block: 1rem;
  }
  label {
    display: block;
    margin-block: 1rem;
  }
  :global(.removal button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
