<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteKeyActivationPrepareResult,
    OmniRouteKeyActivationResult,
    OmniRouteActivationHistoryEntry,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    prepareOmniRouteKeyActivation,
    confirmOmniRouteKeyActivation,
    getOmniRouteKeyActivationHistory,
    prepareOmniRouteKeyActivationRollback,
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
    done: (result?: OmniRouteKeyActivationResult) => void;
  } = $props();
  let busy = $state(false);
  let pending = $state<Extract<
    OmniRouteKeyActivationPrepareResult,
    { ok: true }
  > | null>(null);
  let error = $state("");
  let expired = $state(false);
  let acknowledged = $state(false);
  let history = $state<OmniRouteActivationHistoryEntry[] | null>(null);
  let historyOpen = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteKeyActivation(id, !enabled);
      if (!result.ok) {
        error = result.error || "Sleutelwijziging kon niet worden voorbereid.";
        return;
      }
      if (!result.action) {
        error = "Sleutelwijziging kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      acknowledged = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error = "Sleutelwijziging kon niet worden voorbereid. Controleer je PIN.";
    } finally {
      busy = false;
    }
  }
  async function toggleHistory() {
    historyOpen = !historyOpen;
    if (!historyOpen || history !== null) return;
    busy = true;
    error = "";
    try {
      history = (await getOmniRouteKeyActivationHistory(id)).revisions;
    } catch {
      error = "Sleutelgeschiedenis kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }
  async function prepareRollback(revision: string) {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteKeyActivationRollback(id, revision);
      if (!result.ok) {
        error = result.error || "Herstel kon niet worden voorbereid.";
        return;
      }
      if (!result.action) {
        error = "Herstel kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      acknowledged = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error =
        "Herstel kon niet worden voorbereid. Laad de sleutelstatus opnieuw.";
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
      const result = await confirmOmniRouteKeyActivation(
        id,
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok)
        error =
          result.error || "Sleutelwijziging kon niet worden gecontroleerd.";
      else if (!approve || result.verified === true) {
        done(approve ? result : undefined);
        if (approve && historyOpen)
          history = (await getOmniRouteKeyActivationHistory(id)).revisions;
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
</script>

<div
  class="activation"
  role="group"
  aria-label="API-sleutel in- of uitschakelen"
>
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending}
    <p>
      Sleutel: {pending.name || name}. Dit geldt voor alle OmniRoute-clients.
    </p>
    <p>
      NOVA blokkeert AI tijdens de wijziging en controleert OmniRoute en lokale
      opslag.
    </p>
    <label>
      <input type="checkbox" bind:checked={acknowledged} />
      Ik begrijp dat dit alle OmniRoute-clients met deze sleutel raakt.
    </label>
    {#if expired}<p role="status">Bevestiging verlopen. Start opnieuw.</p>{/if}
    <Button
      onclick={() => confirm(true)}
      disabled={busy || expired || !acknowledged}
      >Bevestig {pending.enabled ? "inschakelen" : "uitschakelen"}</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {:else}
    <Button onclick={prepare} disabled={busy}
      >{enabled ? "Sleutel uitschakelen" : "Sleutel inschakelen"}</Button
    >
    <Button onclick={toggleHistory} disabled={busy}
      >{historyOpen
        ? "Geschiedenis verbergen"
        : "Wijzigingsgeschiedenis"}</Button
    >
    {#if historyOpen}
      <p>
        Terugzetten kan toegang voor alle clients met deze sleutel opnieuw
        geven.
      </p>
      {#if history === null}<p role="status">Geschiedenis laden…</p>
      {:else if !history.length}<p>Geen sleutelwijzigingen vastgelegd.</p>
      {:else}<ol aria-label="API-sleutelgeschiedenis">
          {#each history as revision, index (revision.id)}
            <li>
              <time datetime={revision.at}
                >{new Date(revision.at).toLocaleString("nl-NL")}</time
              >
              · {revision.beforeEnabled ? "Actief" : "Uit"} → {revision.afterEnabled
                ? "Actief"
                : "Uit"}
              {#if index === 0 && enabled === revision.afterEnabled}
                <Button
                  onclick={() => prepareRollback(revision.id)}
                  disabled={busy}>Zet terug</Button
                >
              {/if}
            </li>
          {/each}
        </ol>{/if}
    {/if}
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
