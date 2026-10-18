<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import type {
    PersonaHistory as History,
    PersonaRevision,
  } from "@nova/contracts";
  import {
    getPersonaHistory,
    rollbackPersonaRevision,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let history = $state<History | null>(null);
  let busy = $state(false);
  let message = $state("");

  async function load() {
    busy = true;
    message = "";
    try {
      history = await getPersonaHistory();
    } catch (error) {
      message =
        error instanceof ApiError
          ? error.message
          : "De wijzigingsgeschiedenis is niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function rollback(revision: PersonaRevision) {
    busy = true;
    message = "";
    try {
      const result = await rollbackPersonaRevision(revision.id);
      message = result.auditWarning ?? "Eigen regels teruggedraaid.";
      history = await getPersonaHistory();
    } catch (error) {
      message =
        error instanceof ApiError ? error.message : "Terugdraaien is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section id="persona-history" aria-label="Eigen-regelsgeschiedenis">
  <h4>Wijzigingsgeschiedenis</h4>
  <p class="hint">
    Privégeschiedenis. Herkenbare tokens en wachtwoorden worden eruit gehaald.
    Herstellen lukt alleen zolang de regels niet opnieuw zijn gewijzigd.
  </p>
  <Button disabled={busy} onclick={load}
    >{busy ? "Even wachten…" : "Geschiedenis laden"}</Button
  >
  {#if message}<p role="status">{message}</p>{/if}
  {#if history}
    {#if history.truncated}<p class="hint">
        Alleen de 50 nieuwste wijzigingen worden getoond.
      </p>{/if}
    {#if history.revisions.length}
      <ol>
        {#each history.revisions as revision (revision.id)}
          <li>
            <time datetime={revision.at}>{revision.at}</time>
            <details>
              <summary>Voor en na bekijken</summary>
              <p><strong>Voor</strong></p>
              <pre>{revision.before || "(leeg)"}</pre>
              <p><strong>Na</strong></p>
              <pre>{revision.after || "(leeg)"}</pre>
            </details>
            <Button disabled={busy} onclick={() => rollback(revision)}
              >Deze wijziging terugdraaien</Button
            >
          </li>
        {/each}
      </ol>
    {:else}<p class="hint">Er zijn nog geen wijzigingen opgeslagen.</p>{/if}
  {/if}
</section>

<style>
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
  }
</style>
