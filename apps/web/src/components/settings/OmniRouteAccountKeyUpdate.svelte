<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteAccountKeyUpdatePrepared,
    OmniRouteAccountKeyUpdateResult,
    OmniRouteAccountsReport,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    confirmOmniRouteAccountKeyUpdate,
    prepareOmniRouteAccountKeyUpdate,
  } from "#lib/api/settings.ts";

  let {
    connections,
    done,
  }: {
    connections: OmniRouteAccountsReport["connections"];
    done: (result?: OmniRouteAccountKeyUpdateResult) => void;
  } = $props();
  let id = $state("");
  let apiKey = $state("");
  let busy = $state(false);
  let error = $state("");
  let pending = $state<OmniRouteAccountKeyUpdatePrepared | null>(null);
  let expired = $state(false);
  let acknowledged = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountKeyUpdate(id, apiKey, true);
      apiKey = "";
      if (!result.ok || !result.action) {
        error = result.error || "Sleutel kon niet worden voorbereid.";
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
      apiKey = "";
      error = "Sleutel kon niet worden voorbereid. Controleer je PIN.";
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
      const result = await confirmOmniRouteAccountKeyUpdate(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) error = result.error || "Sleutel is niet gecontroleerd.";
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

<section class="key-update" aria-label="API-sleutel vervangen">
  <h4>API-sleutel vervangen</h4>
  <p>
    Alleen gewone API-sleutelaccounts worden ondersteund; OAuth en websessies
    niet. De sleutel wordt niet getest door NOVA. OmniRoute kan de wijziging
    naar zijn cloud synchroniseren als die functie aanstaat.
  </p>
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending}
    <p>
      Nieuwe sleutel voor <strong>{pending.name}</strong> · {pending.provider}
    </p>
    <label>
      <input type="checkbox" bind:checked={acknowledged} /> Ik begrijp dat alle OmniRoute-clients
      deze account gebruiken en dat OmniRoute Cloud-sync kan uitvoeren als die is
      ingeschakeld.
    </label>
    {#if expired}<p role="status">
        Bevestiging verlopen. Vul de sleutel opnieuw in.
      </p>{/if}
    <Button
      onclick={() => confirm(true)}
      disabled={busy || expired || !acknowledged}>Sleutel vervangen</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {:else}
    <label>
      Account
      <select bind:value={id}>
        <option value="">Kies een account</option>
        {#each connections as connection (connection.id)}
          <option value={connection.id}>
            {connection.name || connection.provider} · {connection.provider}
          </option>
        {/each}
      </select>
    </label>
    <label>
      Nieuwe API-sleutel
      <input
        type="password"
        bind:value={apiKey}
        maxlength="64000"
        autocomplete="new-password"
      />
    </label>
    <Button onclick={prepare} disabled={busy || !id || !apiKey.trim()}>
      Controleren en voorbereiden
    </Button>
  {/if}
</section>

<style>
  .key-update {
    border: 1px solid var(--color-border, #777);
    padding: 1rem;
    margin-block: 1rem;
  }
  label {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-block: 0.5rem;
  }
  input:not([type="checkbox"]),
  select {
    width: min(100%, 28rem);
    padding: 0.5rem;
  }
  :global(.key-update button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
