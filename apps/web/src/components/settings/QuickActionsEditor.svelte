<script lang="ts">
  import {
    getQuickActionsHistory,
    resetQuickActions,
    rollbackQuickActions,
    saveQuickActions,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import { afterChange, fail, settings } from "./state.svelte.ts";

  let nextKey = 0;
  let rows = $state(
    (settings.data?.quickActions ?? []).map((item) => ({
      key: nextKey++,
      label: item.label,
      prompt: item.prompt,
    })),
  );
  let history = $state<Awaited<
    ReturnType<typeof getQuickActionsHistory>
  > | null>(null);
  let busy = $state(false);

  async function loadHistory(): Promise<void> {
    busy = true;
    try {
      history = await getQuickActionsHistory();
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  function swap(index: number, other: number): void {
    const a = rows[index];
    const b = rows[other];
    if (!a || !b) return;
    rows[index] = b;
    rows[other] = a;
  }

  async function save(): Promise<void> {
    try {
      const result = await saveQuickActions(
        rows.map(({ label, prompt }) => ({ label, prompt })),
      );
      await afterChange(
        `De snelle opdrachten zijn opgeslagen.${result.historyWarning ? ` ${result.historyWarning}` : ""}`,
        {
          kind: "quick-actions",
          items: result.quickActions,
          operation: "save",
        },
      );
      history = null;
    } catch (error) {
      fail(error);
    }
  }

  async function reset(): Promise<void> {
    try {
      const result = await resetQuickActions();
      rows = result.quickActions.map((item) => ({ key: nextKey++, ...item }));
      await afterChange(
        `De standaardknoppen zijn terug.${result.historyWarning ? ` ${result.historyWarning}` : ""}`,
        {
          kind: "quick-actions",
          items: result.quickActions,
          operation: "reset",
        },
      );
      history = null;
    } catch (error) {
      fail(error);
    }
  }

  async function rollback(id: string): Promise<void> {
    if (
      !window.confirm(
        "Deze eerdere snelle opdrachten herstellen? Dit voert ze niet uit.",
      )
    )
      return;
    busy = true;
    try {
      const result = await rollbackQuickActions(id);
      rows = result.quickActions.map((item) => ({ key: nextKey++, ...item }));
      await afterChange(
        `Snelle opdrachten hersteld.${result.auditWarning ? ` ${result.auditWarning}` : ""}`,
        {
          kind: "quick-actions",
          items: result.quickActions,
          operation: "rollback",
        },
      );
      history = await getQuickActionsHistory();
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }
</script>

<section id="quick-actions-history">
  <p class="hint">
    De knoppen die op het beginscherm verschijnen als de invoer zichtbaar is
    (maximaal 8). Een druk op een knop is hetzelfde als de opdracht typen.
  </p>
  <div>
    {#each rows as row, index (row.key)}
      <div class="rep-row header">
        <input
          type="text"
          maxlength="40"
          placeholder="Knoptekst"
          aria-label="Knoptekst"
          data-f="label"
          bind:value={row.label}
        />
        <input
          type="text"
          maxlength="300"
          placeholder="Wat NOVA moet doen als je erop drukt"
          aria-label="Opdracht"
          data-f="prompt"
          bind:value={row.prompt}
        />
        <span>
          <Button aria-label="Omhoog" onclick={() => swap(index, index - 1)}
            >↑</Button
          >
          <Button aria-label="Omlaag" onclick={() => swap(index, index + 1)}
            >↓</Button
          >
        </span>
        <Button aria-label="Verwijderen" onclick={() => rows.splice(index, 1)}
          >×</Button
        >
      </div>
    {/each}
  </div>
  <div class="set-toolbar">
    <Button onclick={() => rows.push({ key: nextKey++, label: "", prompt: "" })}
      >Knop toevoegen</Button
    >
    <Button go onclick={save}>Opslaan</Button>
    <Button disabled={busy} onclick={loadHistory}>Geschiedenis</Button>
    {#if settings.data && !settings.data.quickActionsAreDefault}
      <Button onclick={reset}>Standaard herstellen</Button>
    {/if}
  </div>
  {#if history}
    <section aria-label="Geschiedenis snelle opdrachten">
      <h3>Geschiedenis</h3>
      {#if history.revisions.length}
        {#each history.revisions as revision (revision.id)}
          <details>
            <summary><time datetime={revision.at}>{revision.at}</time></summary>
            <p><strong>Voor</strong></p>
            {#each revision.before.items as action, index (`before-${index}`)}<p
              >
                {action.label}: {action.prompt}
              </p>{/each}
            <p><strong>Na</strong></p>
            {#each revision.after.items as action, index (`after-${index}`)}<p>
                {action.label}: {action.prompt}
              </p>{/each}
            <Button disabled={busy} onclick={() => rollback(revision.id)}
              >Herstel deze versie</Button
            >
          </details>
        {/each}
      {:else}<p class="hint">Nog geen wijzigingen bewaard.</p>{/if}
      {#if history.truncated}<p class="hint">
          Oudere wijzigingen ontbreken.
        </p>{/if}
    </section>
  {/if}
</section>
