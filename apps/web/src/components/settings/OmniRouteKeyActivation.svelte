<script lang="ts">
  import type {
    OmniRouteKeyActivationResult,
    OmniRouteActivationHistoryEntry,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    setOmniRouteKeyActivation,
    getOmniRouteKeyActivationHistory,
    rollbackOmniRouteKeyActivation,
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
  let error = $state("");
  let history = $state<OmniRouteActivationHistoryEntry[] | null>(null);
  let historyOpen = $state(false);
  async function run(
    action: () => Promise<OmniRouteKeyActivationResult>,
    failure: string,
  ) {
    busy = true;
    error = "";
    try {
      const result = await action();
      if (!result.ok) error = result.error || failure;
      else if (result.verified === true) {
        done(result);
        if (historyOpen)
          history = (await getOmniRouteKeyActivationHistory(id)).revisions;
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
      () => setOmniRouteKeyActivation(id, !enabled),
      "Sleutelwijziging kon niet worden gecontroleerd.",
    );
  const rollback = (revision: string) =>
    run(
      () => rollbackOmniRouteKeyActivation(id, revision),
      "Herstel kon niet worden gecontroleerd.",
    );
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
</script>

<div
  class="activation"
  role="group"
  aria-label="API-sleutel in- of uitschakelen"
>
  <p>Sleutel: {name}</p>
  {#if error}<p role="status">{error}</p>{/if}
  <Button onclick={toggle} disabled={busy}
    >{enabled ? "Sleutel uitschakelen" : "Sleutel inschakelen"}</Button
  >
  <Button onclick={toggleHistory} disabled={busy}
    >{historyOpen ? "Geschiedenis verbergen" : "Wijzigingsgeschiedenis"}</Button
  >
  {#if historyOpen}
    <p>
      Terugzetten kan toegang voor alle clients met deze sleutel opnieuw geven.
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
              <Button onclick={() => rollback(revision.id)} disabled={busy}
                >Herstel deze versie</Button
              >
            {/if}
          </li>
        {/each}
      </ol>{/if}
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
