<script lang="ts">
  import type {
    OmniRouteActivationHistoryEntry,
    OmniRouteComboActivationResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    setOmniRouteComboActivation,
    getOmniRouteComboActivationHistory,
    rollbackOmniRouteComboActivation,
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
    done: (result?: OmniRouteComboActivationResult) => void;
  } = $props();
  let busy = $state(false);
  let error = $state("");
  let history = $state<OmniRouteActivationHistoryEntry[] | null>(null);
  let historyError = $state("");
  async function run(
    action: () => Promise<OmniRouteComboActivationResult>,
    failure: string,
  ) {
    busy = true;
    error = "";
    try {
      const result = await action();
      if (!result.ok) error = result.error || failure;
      else if (result.verified === true) {
        done(result);
        await loadHistory();
      } else
        error =
          "Uitkomst onbekend. Controleer OmniRoute en het gratis routebeleid.";
    } catch {
      error =
        "Uitkomst onbekend. Controleer OmniRoute en het gratis routebeleid.";
    } finally {
      busy = false;
    }
  }
  const toggle = () =>
    run(
      () => setOmniRouteComboActivation(id, !enabled),
      "Combo-wijziging kon niet worden gecontroleerd.",
    );
  const rollback = (revision: string) =>
    run(
      () => rollbackOmniRouteComboActivation(id, revision),
      "Herstel kon niet worden gecontroleerd.",
    );
  async function loadHistory() {
    historyError = "";
    try {
      history = (await getOmniRouteComboActivationHistory(id)).revisions;
    } catch {
      historyError = "Combo-geschiedenis kon niet worden geladen.";
    }
  }
</script>

<div
  class="activation"
  role="group"
  aria-label="Combo-route in- of uitschakelen"
>
  {#if error}<p role="status">{error}</p>{/if}
  <Button onclick={toggle} disabled={busy}>
    {enabled ? "Combo uitschakelen" : "Combo inschakelen"}
  </Button>
  <Button onclick={loadHistory} disabled={busy}>Wijzigingsgeschiedenis</Button>
  {#if historyError}<p role="status">{historyError}</p>{/if}
  {#if history}
    {#if history.length}
      <ol aria-label={`Geschiedenis ${name}`}>
        {#each history as revision, index (revision.id)}
          <li>
            <time datetime={revision.at}
              >{new Date(revision.at).toLocaleString("nl-NL")}</time
            >
            — {revision.beforeEnabled ? "actief" : "uit"} → {revision.afterEnabled
              ? "actief"
              : "uit"}
            {#if index === 0}<Button
                disabled={busy}
                onclick={() => rollback(revision.id)}
                >Herstel deze versie</Button
              >
            {:else}<span>Alleen de nieuwste wijziging kan worden hersteld.</span
              >{/if}
          </li>
        {/each}
      </ol>
    {:else}<p>Geen combo-wijzigingen opgeslagen.</p>{/if}
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
