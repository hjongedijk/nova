<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import type {
    SidebarHistory as History,
    SidebarRevision,
  } from "@nova/contracts";
  import {
    getSidebarHistory,
    rollbackSidebarRevision,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";

  let history = $state<History | null>(null);
  let busy = $state(false);
  let message = $state("");
  const describe = (items: SidebarRevision["before"]) =>
    `${items.length} panelen · ${items.filter((item) => item.shown).length} zichtbaar`;

  async function load() {
    busy = true;
    message = "";
    try {
      history = await getSidebarHistory();
    } catch (error) {
      message =
        error instanceof ApiError
          ? error.message
          : "De indelingsgeschiedenis is niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function rollback(revision: SidebarRevision) {
    if (
      !window.confirm(
        "Herstel deze zijbalkindeling? Latere wijzigingen worden beschermd tegen overschrijven.",
      )
    )
      return;
    busy = true;
    message = "";
    try {
      const result = await rollbackSidebarRevision(revision.id);
      message = result.auditWarning ?? "Zijbalkindeling teruggedraaid.";
      history = await getSidebarHistory();
    } catch (error) {
      message =
        error instanceof ApiError ? error.message : "Terugdraaien is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section id="sidebar-history" aria-label="Zijbalk wijzigingsgeschiedenis">
  <h2>Zijbalkindeling</h2>
  <p class="hint">
    Bewaart alleen paneelindeling en zichtbaarheid. Inhoud, prompts en
    bronadressen blijven buiten de geschiedenis.
  </p>
  <Button disabled={busy} onclick={load}
    >{busy ? "Even wachten…" : "Indelingsgeschiedenis laden"}</Button
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
            <p>{describe(revision.before)} → {describe(revision.after)}</p>
            <Button disabled={busy} onclick={() => rollback(revision)}
              >Deze wijziging terugdraaien</Button
            >
          </li>
        {/each}
      </ol>
    {:else}<p class="hint">
        Er zijn nog geen indelingswijzigingen opgeslagen.
      </p>{/if}
  {/if}
</section>
