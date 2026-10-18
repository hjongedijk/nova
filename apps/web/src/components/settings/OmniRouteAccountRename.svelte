<script lang="ts">
  import type {
    OmniRouteAccountRenameHistoryEntry,
    OmniRouteAccountRenameResult,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getOmniRouteAccountRenameHistory,
    renameOmniRouteAccount,
    rollbackOmniRouteAccountRename,
  } from "#lib/api/settings.ts";

  let {
    id,
    provider,
    initialName,
    done,
  }: {
    id: string;
    provider: string;
    initialName: string;
    done: (result?: OmniRouteAccountRenameResult) => void;
  } = $props();
  let editing = $state(false);
  let name = $state("");
  let busy = $state(false);
  let error = $state("");
  let history = $state<OmniRouteAccountRenameHistoryEntry[]>([]);
  let historyLoaded = $state(false);
  let historyBusy = $state(false);

  async function loadHistory() {
    historyBusy = true;
    error = "";
    try {
      history = (await getOmniRouteAccountRenameHistory(id)).revisions;
      historyLoaded = true;
    } catch {
      error = "Accountgeschiedenis kon niet worden geladen.";
    } finally {
      historyBusy = false;
    }
  }

  async function apply(
    run: () => Promise<OmniRouteAccountRenameResult>,
    failure: string,
  ) {
    busy = true;
    error = "";
    try {
      const result = await run();
      if (!result.ok) error = result.error || failure;
      else if (result.verified === true) {
        editing = false;
        await loadHistory();
        done(result);
      } else {
        error =
          "Uitkomst niet gecontroleerd. Controleer de accountnaam in OmniRoute.";
      }
    } catch {
      error = "Uitkomst niet gecontroleerd. Controleer OmniRoute.";
    } finally {
      busy = false;
    }
  }
  const save = () =>
    apply(
      () => renameOmniRouteAccount(id, name),
      "Accountnaam is niet gewijzigd.",
    );
  const rollback = (revisionId: string) =>
    apply(
      () => rollbackOmniRouteAccountRename(id, revisionId),
      "Herstel kon niet worden uitgevoerd.",
    );
</script>

<section aria-label={`Accountnaam wijzigen ${provider}`}>
  {#if error}<p role="status">{error}</p>{/if}
  {#if editing}
    <label>
      Nieuwe accountnaam
      <input
        bind:value={name}
        maxlength="200"
        autocomplete="off"
        disabled={busy}
      />
    </label>
    <Button onclick={save} disabled={busy || !name.trim()}>Naam opslaan</Button>
    <Button
      onclick={() => {
        editing = false;
        error = "";
      }}
      disabled={busy}>Annuleren</Button
    >
  {:else}
    <Button
      onclick={() => {
        name = initialName;
        editing = true;
        error = "";
      }}
      disabled={busy}>Naam wijzigen</Button
    >
    <Button onclick={loadHistory} disabled={busy || historyBusy}>
      {historyBusy ? "Geschiedenis laden…" : "Geschiedenis laden"}
    </Button>
    {#if historyLoaded}
      {#if history.length}
        <ol aria-label={`Naamgeschiedenis ${provider}`}>
          {#each history as revision, index (revision.id)}
            <li>
              <span>{revision.beforeName} → {revision.afterName}</span>
              <time datetime={revision.at}
                >{new Date(revision.at).toLocaleString("nl-NL")}</time
              >
              {#if index === 0}
                <Button onclick={() => rollback(revision.id)} disabled={busy}
                  >Herstel deze versie</Button
                >
              {/if}
            </li>
          {/each}
        </ol>
      {:else}<p>Geen naamswijzigingen opgeslagen.</p>{/if}
    {/if}
  {/if}
</section>
