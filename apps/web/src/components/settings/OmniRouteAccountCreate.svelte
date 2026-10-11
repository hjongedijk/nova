<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteAccountCreatePrepared,
    OmniRouteAccountCreateResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    prepareOmniRouteAccountCreate,
    confirmOmniRouteAccountCreate,
  } from "#lib/api/settings.ts";

  let { done }: { done: (result?: OmniRouteAccountCreateResult) => void } =
    $props();
  let provider = $state("");
  let name = $state("");
  let apiKey = $state("");
  let acknowledged = $state(false);
  let busy = $state(false);
  let error = $state("");
  let pending = $state<OmniRouteAccountCreatePrepared | null>(null);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteAccountCreate(
        provider,
        name,
        apiKey,
        true,
      );
      apiKey = "";
      if (!result.ok || !result.action) {
        error = result.error || "Account kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      apiKey = "";
      error = "Account kon niet worden voorbereid. Controleer je PIN.";
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
      const result = await confirmOmniRouteAccountCreate(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) error = result.error || "Account is niet gecontroleerd.";
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

<section class="creator" aria-label="Provideraccount toevoegen">
  <h4>Provideraccount toevoegen</h4>
  <p>
    Alleen provider-ID, accountnaam en API-sleutel worden verstuurd. OAuth is
    niet ondersteund. OmniRoute kan de sleutel direct testen en provider-API's
    benaderen; NOVA kan kosten en gratis toegang niet garanderen.
  </p>
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending}
    <p>Toe te voegen: <strong>{pending.name}</strong> · {pending.provider}</p>
    <label>
      <input type="checkbox" bind:checked={acknowledged} /> Ik begrijp dat dit account
      beschikbaar wordt voor alle OmniRoute-clients en dat OmniRoute de sleutel kan
      testen en provider-API's kan benaderen. Kosten en gratis toegang zijn niet gegarandeerd.
    </label>
    {#if expired}<p role="status">
        Bevestiging verlopen. Vul het account opnieuw in.
      </p>{/if}
    <Button
      onclick={() => confirm(true)}
      disabled={busy || expired || !acknowledged}>Account toevoegen</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {:else}
    <label
      >Provider-ID <input
        bind:value={provider}
        maxlength="100"
        autocomplete="off"
      /></label
    >
    <label
      >Accountnaam <input
        bind:value={name}
        maxlength="200"
        autocomplete="off"
      /></label
    >
    <label
      >API-sleutel <input
        type="password"
        bind:value={apiKey}
        maxlength="64000"
        autocomplete="new-password"
      /></label
    >
    <Button
      onclick={prepare}
      disabled={busy || !provider.trim() || !name.trim() || !apiKey.trim()}
      >Controleren en voorbereiden</Button
    >
  {/if}
</section>

<style>
  .creator {
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
  input:not([type="checkbox"]) {
    width: min(100%, 28rem);
    padding: 0.5rem;
  }
  :global(.creator button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
