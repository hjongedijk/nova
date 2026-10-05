<script lang="ts">
  import { resetQuickActions, saveQuickActions } from "#lib/api/settings.ts";
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

  function swap(index: number, other: number): void {
    const a = rows[index];
    const b = rows[other];
    if (!a || !b) return;
    rows[index] = b;
    rows[other] = a;
  }

  async function save(): Promise<void> {
    try {
      await saveQuickActions(
        rows.map(({ label, prompt }) => ({ label, prompt })),
      );
      await afterChange("De snelle opdrachten zijn opgeslagen.");
    } catch (error) {
      fail(error);
    }
  }

  async function reset(): Promise<void> {
    try {
      await resetQuickActions();
      await afterChange("De standaardknoppen zijn terug.");
    } catch (error) {
      fail(error);
    }
  }
</script>

<section>
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
    {#if settings.data && !settings.data.quickActionsAreDefault}
      <Button onclick={reset}>Standaard herstellen</Button>
    {/if}
  </div>
</section>
