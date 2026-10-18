<script lang="ts">
  import type {
    OmniRouteAccountsReport,
    OmniRouteComboUpdateHistoryEntry,
    OmniRouteComboUpdateResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    updateOmniRouteCombo,
    getOmniRouteComboUpdateHistory,
    rollbackOmniRouteComboUpdate,
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
  let busy = $state(false);
  let error = $state("");
  let history = $state<OmniRouteComboUpdateHistoryEntry[]>([]);
  let historyLoaded = $state(false);
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
  async function loadHistory() {
    busy = true;
    error = "";
    try {
      history = (await getOmniRouteComboUpdateHistory(id)).revisions;
      historyLoaded = true;
    } catch {
      error = "Combo-geschiedenis kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }
  async function run(
    action: () => Promise<OmniRouteComboUpdateResult>,
    failure: string,
  ) {
    busy = true;
    error = "";
    try {
      const result = await action();
      if (!result.ok) error = result.error || failure;
      else if (result.verified === true) {
        editing = false;
        if (historyLoaded) await loadHistory();
        done(result);
      } else
        error =
          "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } catch {
      error =
        "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } finally {
      busy = false;
    }
  }
  const save = () =>
    run(
      () => updateOmniRouteCombo(id, name, selected),
      "Wijziging is niet gecontroleerd.",
    );
  const rollback = (revisionId: string) =>
    run(
      () => rollbackOmniRouteComboUpdate(id, revisionId),
      "Herstel is niet gecontroleerd.",
    );
</script>

{#if !editing}
  <Button onclick={beginEditing}>Combo bewerken</Button>
  <Button onclick={loadHistory} disabled={busy}
    >Wijzigingsgeschiedenis laden</Button
  >
  {#if error}<p role="status">{error}</p>{/if}
  {#if historyLoaded}
    {#if history.length}
      <ol aria-label="Combo-wijzigingsgeschiedenis">
        {#each history as revision, index (revision.id)}
          <li>
            <span>{revision.beforeName} → {revision.afterName}</span>
            <time datetime={revision.at}
              >{new Date(revision.at).toLocaleString("nl-NL")}</time
            >
            <p>
              {revision.beforeModels.join(", ")} → {revision.afterModels.join(
                ", ",
              )}
            </p>
            {#if index === 0}<Button
                onclick={() => rollback(revision.id)}
                disabled={busy}>Herstel deze versie</Button
              >{/if}
          </li>
        {/each}
      </ol>
    {:else}<p>Geen combo-wijzigingen opgeslagen.</p>{/if}
  {/if}
{:else}
  <section class="editor" aria-label="Combo bewerken">
    <h4>Combo bewerken</h4>
    <p>
      Alle OmniRoute-clients kunnen deze wijziging merken. Alleen naam en
      modellen veranderen.
    </p>
    {#if error}<p role="status">{error}</p>{/if}
    <label
      >Naam <input bind:value={name} maxlength="80" autocomplete="off" /></label
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
      onclick={save}
      disabled={busy ||
        !name.trim() ||
        selected.length < 1 ||
        selected.length > 8}>Combo opslaan</Button
    >
    <Button onclick={() => (editing = false)} disabled={busy}>Terug</Button>
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
