<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import type {
    PersonaPreferencesHistory as History,
    PersonaPreferencesRevision,
  } from "@nova/contracts";
  import {
    getPersonaPreferencesHistory,
    rollbackPersonaPreferences,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let history = $state<History | null>(null);
  let busy = $state(false);
  let message = $state("");

  async function load() {
    busy = true;
    message = "";
    try {
      history = await getPersonaPreferencesHistory();
    } catch {
      message = "De profielgeschiedenis kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }

  async function rollback(revision: PersonaPreferencesRevision) {
    busy = true;
    message = "";
    try {
      const result = await rollbackPersonaPreferences(revision.id);
      message = result.auditWarning ?? "NOVA's stijl en profiel hersteld.";
      history = await getPersonaPreferencesHistory();
    } catch (error) {
      message =
        error instanceof ApiError
          ? error.message
          : "Profiel herstellen is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section id="persona-preferences-history" aria-label="Profielgeschiedenis">
  <h4>Stijl- en profielgeschiedenis</h4>
  <p class="hint">
    Privégeschiedenis op dit apparaat. Gevoelige tekst wordt niet opgeslagen;
    herstellen lukt alleen zolang stijl en profiel niet opnieuw zijn gewijzigd.
  </p>
  <Button disabled={busy} onclick={load}
    >{busy ? "Even wachten…" : "Profielgeschiedenis laden"}</Button
  >
  {#if message}<p role="status">{message}</p>{/if}
  {#if history}
    {#if history.truncated}<p class="hint">
        Alleen de 20 nieuwste wijzigingen worden getoond.
      </p>{/if}
    {#if history.revisions.length}
      <ol>
        {#each history.revisions as revision (revision.id)}
          <li>
            <time datetime={revision.at}>{revision.at}</time>
            <details>
              <summary>Voor en na bekijken</summary>
              <p><strong>Voor</strong></p>
              <pre>{JSON.stringify(revision.before, null, 2)}</pre>
              <p><strong>Na</strong></p>
              <pre>{JSON.stringify(revision.after, null, 2)}</pre>
            </details>
            <Button disabled={busy} onclick={() => rollback(revision)}
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

<style>
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
  }
</style>
