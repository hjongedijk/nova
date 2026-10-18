<script lang="ts">
  import type {
    OmniRouteAccountsReport,
    OmniRouteComboCreateResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import { createOmniRouteCombo } from "#lib/api/settings.ts";

  let {
    models,
    done,
  }: {
    models: OmniRouteAccountsReport["models"];
    done: (result?: OmniRouteComboCreateResult) => void;
  } = $props();
  let name = $state("");
  let selected = $state<string[]>([]);
  let busy = $state(false);
  let error = $state("");

  function toggle(model: string, checked: boolean) {
    selected = checked
      ? [...selected, model]
      : selected.filter((item) => item !== model);
  }
  async function create() {
    busy = true;
    error = "";
    try {
      const result = await createOmniRouteCombo(name, selected);
      if (!result.ok) error = result.error || "Combo is niet gecontroleerd.";
      else if (result.verified === true) done(result);
      else
        error =
          "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } catch {
      error =
        "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="creator" aria-label="Combo-route aanmaken">
  <h4>Combo-route aanmaken</h4>
  <p>Voeg een route toe aan OmniRoute voor alle OmniRoute-clients.</p>
  {#if error}<p role="status">{error}</p>{/if}
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
    onclick={create}
    disabled={busy ||
      !name.trim() ||
      selected.length < 1 ||
      selected.length > 8}>Combo aanmaken</Button
  >
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
