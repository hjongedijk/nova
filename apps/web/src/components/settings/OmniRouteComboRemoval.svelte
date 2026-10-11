<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteComboRemovalPrepared,
    OmniRouteComboRemovalResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    prepareOmniRouteComboRemoval,
    confirmOmniRouteComboRemoval,
  } from "#lib/api/settings.ts";
  let {
    id,
    name,
    done,
  }: {
    id: string;
    name: string;
    done: (result?: OmniRouteComboRemovalResult) => void;
  } = $props();
  let busy = $state(false);
  let error = $state("");
  let pending = $state<OmniRouteComboRemovalPrepared | null>(null);
  let acknowledged = $state(false);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteComboRemoval(id);
      if (!result.ok || !result.action) {
        error = result.error || "Combo kon niet worden voorbereid.";
        return;
      }
      pending = result;
      acknowledged = false;
      expired = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error = "Combo kon niet worden voorbereid. Controleer je PIN.";
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
      const result = await confirmOmniRouteComboRemoval(
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
          "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } catch {
      error =
        "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } finally {
      pending = null;
      clearTimeout(timer);
      busy = false;
    }
  }
</script>

<div class="removal" role="group" aria-label="Combo-route verwijderen">
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending?.action}
    <p>Verwijder combo-route: <strong>{pending.name || name}</strong></p>
    <p>
      Dit kan bestaande OmniRoute-clients en routes raken. Verwijderen kan niet
      ongedaan worden gemaakt.
    </p>
    <label
      ><input type="checkbox" bind:checked={acknowledged} /> Ik begrijp dat dit alle
      OmniRoute-clients kan raken.</label
    >
    {#if expired}<p role="status">Bevestiging verlopen. Start opnieuw.</p>{/if}
    <Button
      onclick={() => confirm(true)}
      disabled={busy || expired || !acknowledged}>Combo verwijderen</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {:else}
    <Button onclick={prepare} disabled={busy}>Combo verwijderen</Button>
  {/if}
</div>

<style>
  .removal {
    border: 1px solid var(--color-danger, #c33);
    padding: 1rem;
    margin-block: 0.5rem;
  }
  label {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-block: 0.5rem;
  }
  :global(.removal button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
