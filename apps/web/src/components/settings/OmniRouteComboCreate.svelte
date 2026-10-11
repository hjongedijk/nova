<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteAccountsReport,
    OmniRouteComboCreatePrepared,
    OmniRouteComboCreateResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    prepareOmniRouteComboCreate,
    confirmOmniRouteComboCreate,
  } from "#lib/api/settings.ts";

  let {
    models,
    done,
  }: {
    models: OmniRouteAccountsReport["models"];
    done: (result?: OmniRouteComboCreateResult) => void;
  } = $props();
  let name = $state("");
  let selected = $state<string[]>([]);
  let acknowledged = $state(false);
  let busy = $state(false);
  let error = $state("");
  let pending = $state<Extract<
    OmniRouteComboCreatePrepared,
    { ok: true }
  > | null>(null);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  function toggle(model: string, checked: boolean) {
    selected = checked
      ? [...selected, model]
      : selected.filter((item) => item !== model);
  }
  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteComboCreate(name, selected);
      if (!result.ok) {
        error = result.error || "Combo kon niet worden voorbereid.";
        return;
      }
      if (!result.action) {
        error = "Combo kon niet worden voorbereid.";
        return;
      }
      pending = result;
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
      const result = await confirmOmniRouteComboCreate(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) error = result.error || "Combo is niet gecontroleerd.";
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

<section class="creator" aria-label="Combo-route aanmaken">
  <h4>Combo-route aanmaken</h4>
  <p>
    Voeg een route toe aan OmniRoute. Die kan zichtbaar en bruikbaar worden voor
    alle OmniRoute-clients. De catalogusclaim “gratis” is geen garantie voor je
    account of factuur.
  </p>
  {#if error}<p role="status">{error}</p>{/if}
  {#if pending}
    <p>Nieuwe combo: <strong>{pending.name}</strong></p>
    <ul>
      {#each pending.models ?? [] as model (model)}<li>{model}</li>{/each}
    </ul>
    <label
      ><input type="checkbox" bind:checked={acknowledged} /> Ik begrijp dat deze route
      alle OmniRoute-clients kan raken en geen factureringsgarantie geeft.</label
    >
    {#if expired}<p role="status">Bevestiging verlopen. Start opnieuw.</p>{/if}
    <Button
      onclick={() => confirm(true)}
      disabled={busy || expired || !acknowledged}>Combo aanmaken</Button
    >
    <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
  {:else}
    <label
      >Naam <input bind:value={name} maxlength="80" autocomplete="off" /></label
    >
    <fieldset>
      <legend>Actieve catalogusmodellen ({selected.length}/8)</legend>
      {#each models.filter((model) => model.freeType.length > 0) as model (`${model.provider}/${model.modelId}`)}
        {@const id = `${model.provider}/${model.modelId}`}
        <label
          ><input
            type="checkbox"
            checked={selected.includes(id)}
            disabled={!selected.includes(id) && selected.length >= 8}
            onchange={(event) => toggle(id, event.currentTarget.checked)}
          />{id} · {model.freeType}</label
        >
      {/each}
      {#if !models.some((model) => model.freeType.length > 0)}<p>
          Geen bruikbaar catalogusmodel beschikbaar.
        </p>{/if}
    </fieldset>
    <Button
      onclick={prepare}
      disabled={busy ||
        !name.trim() ||
        selected.length < 1 ||
        selected.length > 8}>Controleren en voorbereiden</Button
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
  fieldset {
    display: grid;
    gap: 0.25rem;
    margin-block: 1rem;
  }
  :global(.creator button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
