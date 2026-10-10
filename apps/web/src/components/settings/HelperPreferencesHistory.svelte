<script lang="ts">
  import type {
    HelperPreferenceHistory as History,
    HelperPreferenceRevision,
  } from "@nova/contracts";
  import {
    getHelperPreferenceHistory,
    rollbackHelperPreferenceRevision,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let history = $state<History | null>(null);
  let busy = $state(false);
  let message = $state("");

  const summary = (value: HelperPreferenceRevision["before"]) =>
    `${value.shape}, hoog contrast ${value.contrast ? "aan" : "uit"}, automatisch verbergen ${value.autohide ? "aan" : "uit"}`;

  async function load() {
    busy = true;
    message = "";
    try {
      history = await getHelperPreferenceHistory();
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "De wijzigingsgeschiedenis is niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function rollback(revision: HelperPreferenceRevision) {
    if (
      !window.confirm(
        "Herstel deze helperinstellingen? Latere wijzigingen worden beschermd tegen overschrijven.",
      )
    )
      return;
    busy = true;
    message = "";
    try {
      const result = await rollbackHelperPreferenceRevision(revision.id);
      message = result.auditWarning ?? "Helperinstellingen teruggedraaid.";
      history = await getHelperPreferenceHistory();
    } catch (error) {
      message =
        error instanceof Error ? error.message : "Terugdraaien is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="Helper wijzigingsgeschiedenis">
  <h2>Helperwijzigingen</h2>
  <p class="hint">
    Bekijk helpervoorkeuren en herstel een wijziging zolang ze daarna niet
    opnieuw zijn aangepast.
  </p>
  <Button disabled={busy} onclick={load}
    >{busy ? "Even wachten…" : "Helpergeschiedenis laden"}</Button
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
            <p>{summary(revision.before)} → {summary(revision.after)}</p>
            <Button disabled={busy} onclick={() => rollback(revision)}
              >Deze wijziging terugdraaien</Button
            >
          </li>
        {/each}
      </ol>
    {:else}<p class="hint">
        Er zijn nog geen helperwijzigingen opgeslagen.
      </p>{/if}
  {/if}
</section>
