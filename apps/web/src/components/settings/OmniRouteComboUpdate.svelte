<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    OmniRouteAccountsReport,
    OmniRouteComboUpdatePrepared,
    OmniRouteComboUpdateResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    prepareOmniRouteComboUpdate,
    confirmOmniRouteComboUpdate,
  } from "#lib/api/settings.ts";

  let {
    id,
    initialName,
    initialModels,
    models,
    done,
  }: {
    id: string;
    initialName: string;
    initialModels: string[];
    models: OmniRouteAccountsReport["models"];
    done: (result?: OmniRouteComboUpdateResult) => void;
  } = $props();
  let editing = $state(false);
  let name = $state("");
  let selected = $state<string[]>([]);
  let acknowledged = $state(false);
  let busy = $state(false);
  let error = $state("");
  let pending = $state<OmniRouteComboUpdatePrepared | null>(null);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  function beginEditing() {
    name = initialName;
    selected = [...initialModels];
    editing = true;
  }
  function toggle(model: string, checked: boolean) {
    selected = checked
      ? [...selected, model]
      : selected.filter((item) => item !== model);
  }
  async function prepare() {
    busy = true;
    error = "";
    try {
      const result = await prepareOmniRouteComboUpdate(id, name, selected);
      if (!result.ok || !result.action) {
        error = result.error || "Wijziging kon niet worden voorbereid.";
        return;
      }
      pending = result;
      expired = false;
      timer = setTimeout(
        () => (expired = true),
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error = "Wijziging kon niet worden voorbereid. Controleer je PIN.";
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
      const result = await confirmOmniRouteComboUpdate(
        id,
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok)
        error = result.error || "Wijziging is niet gecontroleerd.";
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

{#if !editing}
  <Button onclick={beginEditing}>Combo bewerken</Button>
{:else}
  <section class="editor" aria-label="Combo bewerken">
    <h4>Combo bewerken</h4>
    <p>
      Alle OmniRoute-clients kunnen deze wijziging merken. Alleen naam en
      modellen veranderen.
    </p>
    {#if error}<p role="status">{error}</p>{/if}
    {#if pending}
      <p>Nieuwe route: <strong>{pending.name}</strong></p>
      <ul>
        {#each pending.models ?? [] as model (model)}<li>{model}</li>{/each}
      </ul>
      <label
        ><input type="checkbox" bind:checked={acknowledged} /> Ik begrijp dat deze
        wijziging alle clients kan raken.</label
      >
      {#if expired}<p role="status">
          Bevestiging verlopen. Start opnieuw.
        </p>{/if}
      <Button
        onclick={() => confirm(true)}
        disabled={busy || expired || !acknowledged}>Wijziging bevestigen</Button
      >
      <Button onclick={() => confirm(false)} disabled={busy}>Annuleren</Button>
    {:else}
      <label
        >Naam <input
          bind:value={name}
          maxlength="80"
          autocomplete="off"
        /></label
      >
      <fieldset>
        <legend>Actieve catalogusmodellen ({selected.length}/8)</legend>
        {#each models.filter((model) => model.freeType.length > 0) as model (`${model.provider}/${model.modelId}`)}
          {@const value = `${model.provider}/${model.modelId}`}
          <label
            ><input
              type="checkbox"
              checked={selected.includes(value)}
              disabled={!selected.includes(value) && selected.length >= 8}
              onchange={(event) => toggle(value, event.currentTarget.checked)}
            />{value} · {model.freeType}</label
          >
        {/each}
      </fieldset>
      <Button
        onclick={prepare}
        disabled={busy ||
          !name.trim() ||
          selected.length < 1 ||
          selected.length > 8}>Controleren</Button
      >
      <Button onclick={() => (editing = false)} disabled={busy}>Terug</Button>
    {/if}
  </section>
{/if}

<style>
  .editor {
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
  :global(.editor button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
