<script lang="ts">
  import type {
    OmniRouteActivationHistoryEntry,
    OmniRouteAccountActivationResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    setOmniRouteAccountActivation,
    getOmniRouteAccountActivationHistory,
    rollbackOmniRouteAccountActivation,
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
    done: (result?: OmniRouteAccountActivationResult) => void;
  } = $props();
  let busy = $state(false);
  let error = $state("");
  let history = $state<OmniRouteActivationHistoryEntry[] | null>(null);
  let historyBusy = $state(false);
  let historyError = $state("");
  async function apply(
    run: () => Promise<OmniRouteAccountActivationResult>,
    failure: string,
  ) {
    busy = true;
    error = "";
    try {
      const result = await run();
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
    apply(
      () => setOmniRouteAccountActivation(id, !enabled),
      "Accountwijziging kon niet worden gecontroleerd.",
    );
  const rollback = (revision: string) =>
    apply(
      () => rollbackOmniRouteAccountActivation(id, revision),
      "Herstel kon niet worden uitgevoerd.",
    );
  async function loadHistory() {
    historyBusy = true;
    historyError = "";
    try {
      history = (await getOmniRouteAccountActivationHistory(id)).revisions;
    } catch {
      historyError = "Accountgeschiedenis kon niet worden geladen.";
    } finally {
      historyBusy = false;
    }
  }
</script>

<div
  class="activation"
  role="group"
  aria-label="Provideraccount in- of uitschakelen"
>
  {#if error}<p role="status">{error}</p>{/if}
  <Button onclick={toggle} disabled={busy}>
    {enabled ? "Account uitschakelen" : "Account inschakelen"}
  </Button>
  <Button onclick={loadHistory} disabled={historyBusy || busy}>
    {historyBusy ? "Geschiedenis laden…" : "Wijzigingsgeschiedenis"}
  </Button>
  {#if historyError}<p role="status">{historyError}</p>{/if}
  {#if history}
    {#if history.length}
      <ol aria-label={`Geschiedenis ${name}`}>
        {#each history as revision, index (revision.id)}
          <li>
            <time datetime={revision.at}
              >{new Date(revision.at).toLocaleString("nl-NL")}</time
            >
            — {revision.beforeEnabled ? "actief" : "uit"} →
            {revision.afterEnabled ? "actief" : "uit"}
            {#if index === 0}
              <Button disabled={busy} onclick={() => rollback(revision.id)}
                >Herstel deze versie</Button
              >
            {:else}<span>Alleen de nieuwste wijziging kan worden hersteld.</span
              >{/if}
          </li>
        {/each}
      </ol>
    {:else}<p>Geen accountwijzigingen opgeslagen.</p>{/if}
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
