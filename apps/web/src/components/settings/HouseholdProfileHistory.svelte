<script lang="ts">
  import type {
    HouseholdProfileSwitchHistory,
    HouseholdProfileDefinitionHistory,
  } from "@nova/contracts";
  import {
    getHouseholdProfileHistory,
    rollbackHouseholdProfile,
    getHouseholdProfileDefinitionHistory,
    rollbackHouseholdProfileDefinition,
  } from "#lib/api/settings.ts";
  import { settings } from "./state.svelte.ts";
  import Button from "#components/ui/Button.svelte";

  let { onRestored }: { onRestored: () => Promise<void> } = $props();
  let history = $state<HouseholdProfileSwitchHistory | null>(null);
  let definitionHistory = $state<HouseholdProfileDefinitionHistory | null>(
    null,
  );
  let busy = $state(false);
  let message = $state("");

  function labelFor(id: string): string {
    return (
      settings.data?.householdProfiles.find((profile) => profile.id === id)
        ?.label ?? id
    );
  }

  async function loadDefinitions() {
    busy = true;
    message = "";
    try {
      definitionHistory = await getHouseholdProfileDefinitionHistory();
    } catch {
      message = "De profielinhoudgeschiedenis kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }

  async function rollbackDefinitions(id: string) {
    if (
      !window.confirm(
        "Zet de gezinsprofielen terug naar de vorige inhoud en actieve keuze? Latere wijzigingen blokkeren dit herstel.",
      )
    )
      return;
    busy = true;
    message = "";
    try {
      const result = await rollbackHouseholdProfileDefinition(id);
      message = result.auditWarning ?? "Gezinsprofielen hersteld.";
      await onRestored();
      definitionHistory = await getHouseholdProfileDefinitionHistory();
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "Gezinsprofielen herstellen is mislukt.";
    } finally {
      busy = false;
    }
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

<section aria-label="Geschiedenis gezinsprofielinhoud">
  <h4>Geschiedenis gezinsprofielinhoud</h4>
  <p class="hint">
    Wijzigingen in profielnamen, voorkeuren en de persoonlijkheid worden lokaal
    bewaard als de inhoud geen herkenbare geheimen bevat. Alleen de nieuwste
    wijziging kan worden hersteld als de huidige profielen nog overeenkomen.
  </p>
  <Button disabled={busy} onclick={loadDefinitions}
    >{busy ? "Even wachten…" : "Profielwijzigingen laden"}</Button
  >
  {#if definitionHistory}
    {#if definitionHistory.truncated}<p class="hint">
        Alleen de 20 nieuwste wijzigingen worden getoond.
      </p>{/if}
    {#if definitionHistory.revisions.length}
      <ol>
        {#each definitionHistory.revisions as revision (revision.id)}
          <li>
            <time datetime={revision.at}>{revision.at}</time>
            <p>
              {revision.beforeCount} → {revision.afterCount} profielen; gewijzigd:
              {revision.changedProfileIds.map(labelFor).join(", ") ||
                "actief profiel"}
            </p>
            <Button
              disabled={busy}
              onclick={() => rollbackDefinitions(revision.id)}
              >Deze profielwijziging terugdraaien</Button
            >
          </li>
        {/each}
      </ol>
    {:else}<p class="hint">
        Er zijn nog geen profielwijzigingen opgeslagen.
      </p>{/if}
  {/if}
</section>
