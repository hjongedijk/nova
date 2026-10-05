<script lang="ts">
  import type { SkillInput, SkillType } from "@nova/contracts";
  import { testSkill } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import { fail } from "./state.svelte.ts";

  let {
    type,
    draft,
    read,
  }: { type: SkillType; draft: SkillInput; read: () => SkillInput } = $props();

  let phrase = $state("");
  let output = $state<string | null>(null);
  // One value per parameter, as the field gives it (text, or the on/off switch for yes/no).
  const parameters = $derived(draft.parameters ?? []);
  let values = $state<Record<string, string | boolean>>({});
  const writes = $derived((draft.http?.method ?? "GET") !== "GET");

  async function check(): Promise<void> {
    try {
      const data = await testSkill(read(), { phrase });
      if (data.type === "instruction")
        output = JSON.stringify(
          { gebruikt: data.matched ? "ja" : "nee", zin: data.phrase },
          null,
          2,
        );
    } catch (error) {
      fail(error);
    }
  }

  async function run(): Promise<void> {
    const args: Record<string, unknown> = {};
    for (const param of parameters) {
      const name = param.name ?? "";
      const raw = values[name];
      if (raw === "" || raw === undefined) continue;
      args[name] = ["number", "integer"].includes(param.type ?? "")
        ? Number(raw)
        : raw;
    }
    try {
      output = JSON.stringify(await testSkill(read(), { args }), null, 2);
    } catch (error) {
      fail(error);
    }
  }
</script>

{#if type === "instruction"}
  <div class="panel">
    <strong>Zou NOVA dit draaiboek gebruiken?</strong>
    <p class="hint">
      Dit controleert alleen of de zin bij deze vaardigheid past. Wil je het
      echt proberen, zeg de zin dan tegen NOVA.
    </p>
    <input
      type="text"
      placeholder="Typ een zin, bijv. “start filmavond”"
      aria-label="Testzin"
      bind:value={phrase}
    />
    <div class="editor-actions">
      <Button onclick={check}>Controleer</Button>
    </div>
    {#if output !== null}<pre>{output}</pre>{/if}
  </div>
{:else}
  <div class="panel">
    <strong>Test de aanroep</strong>
    <p class="hint">
      {writes
        ? "Let op: dit voert de aanroep echt uit, ook al staat hij op bevestiging. Gebruik een veilige waarde."
        : "Dit voert de aanroep echt uit."}
    </p>
    {#each parameters as param (param.name)}
      <Field
        label="{param.name}{param.required ? '' : ' (optioneel)'}"
        help={param.description}
      >
        {#if param.enum?.length}
          <select bind:value={values[param.name ?? ""]}>
            {#each param.enum as value (value)}
              <option {value}>{value}</option>
            {/each}
          </select>
        {:else if param.type === "boolean"}
          <Toggle
            label={param.name ?? ""}
            checked={values[param.name ?? ""] === true}
            onchange={(on) => (values[param.name ?? ""] = on)}
          />
        {:else}
          <input
            type={param.type === "string" ? "text" : "number"}
            step={param.type === "integer" ? "1" : "any"}
            bind:value={values[param.name ?? ""]}
          />
        {/if}
      </Field>
    {/each}
    <div class="editor-actions">
      <Button onclick={run}>Voer uit</Button>
    </div>
    {#if output !== null}<pre>{output}</pre>{/if}
  </div>
{/if}
