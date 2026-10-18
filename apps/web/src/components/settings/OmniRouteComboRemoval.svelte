<script lang="ts">
  import type { OmniRouteComboRemovalResult } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import { removeOmniRouteCombo } from "#lib/api/settings.ts";
  let {
    id,
    name,
    done,
  }: {
    id: string;
    name: string;
    done: (result?: OmniRouteComboRemovalResult) => void;
  } = $props();
  let busy = $state(false);
  let error = $state("");
  async function remove() {
    busy = true;
    error = "";
    try {
      const result = await removeOmniRouteCombo(id);
      if (!result.ok)
        error = result.error || "Verwijdering kon niet worden gecontroleerd.";
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

<div class="removal" role="group" aria-label="Combo-route verwijderen">
  <p>Verwijder combo-route: <strong>{name}</strong></p>
  {#if error}<p role="status">{error}</p>{/if}
  <Button onclick={remove} disabled={busy}>Combo verwijderen</Button>
</div>

<style>
  .removal {
    border: 1px solid var(--color-danger, #c33);
    padding: 1rem;
    margin-block: 0.5rem;
  }
  :global(.removal button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
