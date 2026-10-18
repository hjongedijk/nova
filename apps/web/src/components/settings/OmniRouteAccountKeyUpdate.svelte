<script lang="ts">
  import type {
    OmniRouteAccountKeyUpdateResult,
    OmniRouteAccountsReport,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import { updateOmniRouteAccountKey } from "#lib/api/settings.ts";

  let {
    connections,
    done,
  }: {
    connections: OmniRouteAccountsReport["connections"];
    done: (result?: OmniRouteAccountKeyUpdateResult) => void;
  } = $props();
  let id = $state("");
  let apiKey = $state("");
  let busy = $state(false);
  let error = $state("");

  async function update() {
    busy = true;
    error = "";
    try {
      const result = await updateOmniRouteAccountKey(id, apiKey);
      apiKey = "";
      if (!result.ok) error = result.error || "Sleutel is niet gecontroleerd.";
      else if (result.verified === true) done(result);
      else
        error =
          "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } catch {
      apiKey = "";
      error =
        "Uitkomst onbekend. Controleer OmniRoute; NOVA houdt AI geblokkeerd.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="key-update" aria-label="API-sleutel vervangen">
  <h4>API-sleutel vervangen</h4>
  <p>
    Alleen gewone API-sleutelaccounts worden ondersteund; OAuth en websessies
    niet. De sleutel wordt niet getest door NOVA. OmniRoute kan de wijziging
    naar zijn cloud synchroniseren als die functie aanstaat.
  </p>
  {#if error}<p role="status">{error}</p>{/if}
  <label>
    Account
    <select bind:value={id}>
      <option value="">Kies een account</option>
      {#each connections as connection (connection.id)}
        <option value={connection.id}>
          {connection.name || connection.provider} · {connection.provider}
        </option>
      {/each}
    </select>
  </label>
  <label>
    Nieuwe API-sleutel
    <input
      type="password"
      bind:value={apiKey}
      maxlength="64000"
      autocomplete="new-password"
    />
  </label>
  <Button onclick={update} disabled={busy || !id || !apiKey.trim()}>
    Sleutel vervangen
  </Button>
</section>

<style>
  .key-update {
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
  input:not([type="checkbox"]),
  select {
    width: min(100%, 28rem);
    padding: 0.5rem;
  }
  :global(.key-update button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
