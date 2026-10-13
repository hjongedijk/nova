<script lang="ts">
  import type {
    ToolSwitchHistory as History,
    ToolSwitchRevision,
  } from "@nova/contracts";
  import {
    getToolSwitchHistory,
    rollbackToolSwitchRevision,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let history = $state<History | null>(null);
  let busy = $state(false);
  let message = $state("");

  function summary(revision: ToolSwitchRevision) {
    return Object.keys(revision.before)
      .map(
        (name) =>
          `${name}: ${revision.before[name] ? "aan" : "uit"} → ${revision.after[name] ? "aan" : "uit"}`,
      )
      .join(" · ");
  }

  async function load() {
    busy = true;
    message = "";
    try {
      history = await getToolSwitchHistory();
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "De gereedschapsgeschiedenis is niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function rollback(revision: ToolSwitchRevision) {
    if (
      !window.confirm(
        "Herstel deze aan/uit-wijziging? Andere latere toolinstellingen blijven behouden.",
      )
    )
      return;
    busy = true;
    message = "";
    try {
      const result = await rollbackToolSwitchRevision(revision.id);
      message = result.auditWarning ?? "Gereedschapswijziging teruggedraaid.";
      history = await getToolSwitchHistory();
    } catch (error) {
      message =
        error instanceof Error ? error.message : "Terugdraaien is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section
  id="tool-switch-history"
  aria-label="Gereedschap wijzigingsgeschiedenis"
>
  <h2>Gereedschapswijzigingen</h2>
  <p class="hint">
    Bewaart alleen toolnamen en aan/uit-statussen. Beschrijvingen en invoer
    blijven buiten de geschiedenis.
  </p>
  <Button disabled={busy} onclick={load}
    >{busy ? "Even wachten…" : "Gereedschapsgeschiedenis laden"}</Button
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
            <p>{summary(revision)}</p>
            <Button disabled={busy} onclick={() => rollback(revision)}
              >Deze wijziging terugdraaien</Button
            >
          </li>
        {/each}
      </ol>
    {:else}<p class="hint">
        Er zijn nog geen schakelwijzigingen opgeslagen.
      </p>{/if}
  {/if}
</section>
