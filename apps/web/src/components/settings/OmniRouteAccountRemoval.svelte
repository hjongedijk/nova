<script lang="ts">
  import type { OmniRouteAccountRemovalResult } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import { removeOmniRouteAccount } from "#lib/api/settings.ts";
  let {
    id,
    name,
    done,
  }: {
    id: string;
    name: string;
    done: (result?: OmniRouteAccountRemovalResult) => void;
  } = $props();
  let busy = $state(false);
  let error = $state("");
  async function remove() {
    busy = true;
    error = "";
    try {
      const result = await removeOmniRouteAccount(id);
      if (!result.ok)
        error = result.error || "Verwijdering kon niet worden gecontroleerd.";
      else if (result.verified === true) done(result);
      else
        error =
          "Verwijdering is niet gecontroleerd. Laad het accountoverzicht opnieuw.";
    } catch {
      error =
        "Uitkomst onbekend. Het account kan al verwijderd zijn. Controleer de accounts en gratis route.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="removal" role="group" aria-label="Gateway-account verwijderen">
  <h3>Verwijder {name}</h3>
  <p>
    Dit verwijdert het account en gekoppelde model- en routegegevens voor alle
    OmniRoute-clients. NOVA blokkeert AI tijdens de wijziging; alleen een
    opnieuw geverifieerde gratis route gaat daarna verder.
  </p>
  {#if error}<p role="status">{error}</p>{/if}
  <Button onclick={remove} disabled={busy}>Verwijder account</Button>
  <Button onclick={() => done()} disabled={busy}>Sluiten</Button>
</div>

<style>
  .removal {
    border: 1px solid #ff8a33;
    padding: 1rem;
    margin-block: 1rem;
  }
  :global(.removal button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
