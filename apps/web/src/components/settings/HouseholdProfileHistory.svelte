<script lang="ts">
  import type { HouseholdProfileSwitchHistory } from "@nova/contracts";
  import {
    getHouseholdProfileHistory,
    rollbackHouseholdProfile,
  } from "#lib/api/settings.ts";
  import { settings } from "./state.svelte.ts";
  import Button from "#components/ui/Button.svelte";

  let { onRestored }: { onRestored: () => Promise<void> } = $props();
  let history = $state<HouseholdProfileSwitchHistory | null>(null);
  let busy = $state(false);
  let message = $state("");

  function labelFor(id: string): string {
    return (
      settings.data?.householdProfiles.find((profile) => profile.id === id)
        ?.label ?? "niet beschikbaar profiel"
    );
  }

  async function load() {
    busy = true;
    message = "";
    try {
      history = await getHouseholdProfileHistory();
    } catch {
      message = "De profielwisselgeschiedenis kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }

  async function rollback(id: string) {
    if (
      !window.confirm(
        "Zet NOVA terug naar het vorige actieve gezinsprofiel? Alleen de profielkeuze wordt hersteld.",
      )
    )
      return;
    busy = true;
    message = "";
    try {
      const result = await rollbackHouseholdProfile(id);
      message = result.auditWarning ?? "Actief gezinsprofiel hersteld.";
      await onRestored();
      history = await getHouseholdProfileHistory();
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "Gezinsprofiel herstellen is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="Geschiedenis actieve gezinsprofielen">
  <h4>Geschiedenis actieve gezinsprofielen</h4>
  <p class="hint">
    Alleen profiel-ID's en tijden worden bewaard; namen en profielinhoud blijven
    buiten deze lokale geschiedenis. Herstellen werkt alleen als beide profielen
    nog bestaan en de actieve keuze niet later is gewijzigd.
  </p>
  <Button disabled={busy} onclick={load}
    >{busy ? "Even wachten…" : "Profielwissels laden"}</Button
  >
  {#if message}<p role="status">{message}</p>{/if}
  {#if history}
    {#if history.truncated}<p class="hint">
        Alleen de 20 nieuwste wissels worden getoond.
      </p>{/if}
    {#if history.revisions.length}
      <ol>
        {#each history.revisions as revision (revision.id)}
          <li>
            <time datetime={revision.at}>{revision.at}</time>
            <p>
              Van {labelFor(revision.beforeProfileId)} naar {labelFor(
                revision.afterProfileId,
              )}
            </p>
            <Button disabled={busy} onclick={() => rollback(revision.id)}
              >Deze profielwissel terugdraaien</Button
            >
          </li>
        {/each}
      </ol>
    {:else}<p class="hint">Er zijn nog geen profielwissels opgeslagen.</p>{/if}
  {/if}
</section>
