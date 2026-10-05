<script lang="ts">
  import type { SkillInput, SkillSuggestion, SkillType } from "@nova/contracts";
  import { improveSkill } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import { fail, say } from "./state.svelte.ts";

  type Change = { key: string; value: string | string[] };
  let {
    type,
    read,
    apply,
  }: {
    type: SkillType;
    read: () => SkillInput;
    apply: (change: Change) => void;
  } = $props();

  interface Row {
    label: string;
    before: string;
    after: string;
    change: Change;
    take: boolean;
  }

  let goal = $state("");
  let busy = $state(false);
  let thinking = $state(false);
  let notes = $state("");
  let rows = $state<Row[]>([]);

  function rowsFor(suggestion: SkillSuggestion, draft: SkillInput): Row[] {
    const c = suggestion.changes;
    const list: Row[] = [];
    const add = (
      label: string,
      before: string,
      after: string,
      change: Change,
    ) => list.push({ label, before, after, change, take: true });
    if (c.name)
      add("Naam", draft.name ?? "", c.name, { key: "name", value: c.name });
    if (c.description)
      add("Beschrijving", draft.description ?? "", c.description, {
        key: "description",
        value: c.description,
      });
    if (c.examples)
      add(
        "Voorbeelden",
        (draft.examples ?? []).join(" / "),
        c.examples.join(" / "),
        { key: "examples", value: c.examples },
      );
    if (c.instructions && type === "instruction")
      add("Instructies", draft.instructions ?? "", c.instructions, {
        key: "instructions",
        value: c.instructions,
      });
    for (const [name, text] of Object.entries(c.parameterDescriptions ?? {}))
      add(
        `Parameter ${name}`,
        draft.parameters?.find((p) => p.name === name)?.description ?? "",
        text,
        { key: `param:${name}`, value: text },
      );
    return list;
  }

  async function propose(): Promise<void> {
    busy = true;
    thinking = true;
    rows = [];
    notes = "";
    try {
      const draft = read();
      const data = await improveSkill(draft, goal);
      notes = data.notes ?? "";
      rows = rowsFor(data, draft);
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
      thinking = false;
    }
  }

  function takeOver(): void {
    for (const row of rows) if (row.take) apply(row.change);
    say("Voorstel overgenomen. Controleer het en druk op Opslaan.", "ok");
    rows = [];
    notes = "";
  }
</script>

<div class="panel">
  <strong>Verbeteren</strong>
  <p class="hint">
    NOVA kijkt naar de tekst en naar recente mislukte aanroepen, en stelt betere
    formuleringen voor. Er wordt niets opgeslagen voordat jij op Opslaan drukt.
  </p>
  <input
    type="text"
    placeholder="Wat moet beter? (optioneel) bijv. “NOVA snapt niet wanneer hij dit moet gebruiken”"
    aria-label="Doel"
    bind:value={goal}
  />
  <div class="editor-actions">
    <Button go disabled={busy} onclick={propose}
      >Laat NOVA een voorstel doen</Button
    >
  </div>
  <div>
    {#if thinking}<p class="hint">NOVA denkt na…</p>{/if}
    {#if notes}<p class="hint">{notes}</p>{/if}
    {#each rows as row (row.label)}
      <div class="diff">
        <label>
          <Toggle label="{row.label} overnemen" bind:checked={row.take} />
          <strong>{row.label}</strong>
        </label>
        <div class="old">{row.before || "(leeg)"}</div>
        <div class="new">{row.after}</div>
      </div>
    {/each}
    {#if rows.length}
      <div class="editor-actions">
        <Button go onclick={takeOver}>Overnemen in het formulier</Button>
      </div>
    {/if}
  </div>
</div>
