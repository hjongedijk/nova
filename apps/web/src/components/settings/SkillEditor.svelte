<script lang="ts">
  import { untrack } from "svelte";
  import type {
    Skill,
    SkillInput,
    SkillParameter,
    SkillParameterType,
    SkillRisk,
    SkillType,
  } from "@nova/contracts";
  import { createSkill, deleteSkill, updateSkill } from "#lib/api/settings.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import SkillImprovePanel from "./SkillImprovePanel.svelte";
  import SkillRunsPanel from "./SkillRunsPanel.svelte";
  import SkillTestPanel from "./SkillTestPanel.svelte";
  import { afterChange, fail, say, settings } from "./state.svelte.ts";

  const props: { type: SkillType; skill: Skill | null; draft?: SkillInput } =
    $props();
  // The editor is created per skill ({#key} in SkillsTab): it starts from what it is given.
  const { type, skill, draft } = untrack(() => props);

  const isNew = skill === null;
  // A stored skill wins; a new one starts from the defaults plus the proposal from "Maak een voorstel".
  const start = {
    enabled: true,
    examples: [] as string[],
    ...(skill ?? draft ?? {}),
  } as Partial<Skill> & SkillInput;
  const http = (skill?.type === "webhook" ? skill.http : draft?.http) ?? {};

  let name = $state(start.name ?? "");
  let description = $state(start.description ?? "");
  let examples = $state((start.examples ?? []).join("\n"));
  let enabled = $state(start.enabled !== false);
  let instructions = $state(
    (skill?.type === "instruction"
      ? skill.instructions
      : draft?.instructions) ?? "",
  );

  let method = $state(http.method ?? "GET");
  let url = $state(http.url ?? "");
  let body = $state(http.body ?? "");
  let extract = $state(http.extract ?? "");
  let timeout = $state(String(Math.round((http.timeoutMs ?? 10000) / 1000)));
  let allowPrivate = $state(http.allowPrivate === true);
  let risk = $state<string>(
    (skill?.type === "webhook" ? skill.risk : draft?.risk) ?? "SAFE",
  );

  let nextKey = 0;
  interface ParamRow {
    key: number;
    name: string;
    type: SkillParameterType;
    description: string;
    required: boolean;
    choices: string;
  }
  interface HeaderRow {
    key: number;
    name: string;
    value: string;
    secret: boolean;
    /** A secret that is stored on the server: left empty it stays as it is. */
    stored: boolean;
  }
  const paramRow = (item: Partial<SkillParameter> = {}): ParamRow => ({
    key: nextKey++,
    name: item.name ?? "",
    type: item.type ?? "string",
    description: item.description ?? "",
    required: item.required !== false,
    choices: (item.enum ?? []).join(", "),
  });
  const headerRow = (
    item: { name?: string; value?: string; set?: boolean },
    secret: boolean,
  ): HeaderRow => ({
    key: nextKey++,
    name: item.name ?? "",
    value: secret ? "" : (item.value ?? ""),
    secret,
    stored: secret && item.set === true,
  });

  const initialParams =
    (skill?.type === "webhook" ? skill.parameters : draft?.parameters) ?? [];
  let params = $state<ParamRow[]>(initialParams.map(paramRow));
  let headers = $state<HeaderRow[]>([
    ...(http.headers ?? []).map((item) => headerRow(item, false)),
    ...(http.secretHeaders ?? []).map((item) => headerRow(item, true)),
  ]);

  let tool = $state<"test" | "improve" | "runs" | null>(null);
  let testDraft = $state<SkillInput>({});
  let sure = $state(false);

  function read(): SkillInput {
    const result: SkillInput = {
      type,
      name,
      description,
      examples: examples
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      enabled,
    };
    if (type === "instruction") result.instructions = instructions;
    else {
      result.parameters = params.map((row) => {
        const choices = row.choices
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        return {
          name: row.name.trim(),
          type: row.type,
          description: row.description,
          required: row.required,
          ...(choices.length ? { enum: choices } : {}),
        };
      });
      const pair = (row: HeaderRow) => ({
        name: row.name.trim(),
        value: row.value,
      });
      result.http = {
        method,
        url,
        body,
        extract,
        timeoutMs: Math.round(Number(timeout) * 1000) || 10000,
        allowPrivate,
        headers: headers.filter((row) => !row.secret).map(pair),
        secretHeaders: headers.filter((row) => row.secret).map(pair),
      };
      result.risk = risk as SkillRisk;
    }
    return result;
  }

  async function save(): Promise<void> {
    try {
      const input = read();
      if (isNew) await createSkill(input);
      else await updateSkill(skill.id, input);
      settings.editing = null;
      await afterChange(`“${input.name}” is opgeslagen.`);
    } catch (error) {
      fail(error);
    }
  }

  async function remove(): Promise<void> {
    if (!skill) return;
    if (!sure) {
      sure = true;
      return;
    }
    try {
      await deleteSkill(skill.id);
      settings.editing = null;
      await afterChange(`“${skill.name}” is verwijderd.`);
    } catch (error) {
      fail(error);
    }
  }

  function openTest(): void {
    testDraft = read();
    tool = "test";
  }

  /** The user accepted (part of) a proposal: copy it into the form. */
  function apply(change: { key: string; value: string | string[] }): void {
    const { key, value } = change;
    if (key === "name") name = String(value);
    else if (key === "description") description = String(value);
    else if (key === "examples") examples = [value].flat().join("\n");
    else if (key === "instructions") instructions = String(value);
    else if (key.startsWith("param:")) {
      const row = params.find((item) => item.name.trim() === key.slice(6));
      if (row) row.description = String(value);
    }
  }

  const heading = isNew
    ? type === "webhook"
      ? "Nieuwe webhook"
      : "Nieuwe instructie"
    : `Bewerken: ${skill.name}`;

  function focus(node: HTMLElement): void {
    node.focus();
  }
</script>

<h3>{heading}</h3>

<Field
  label="Naam"
  id="skName"
  help={isNew
    ? "Korte naam. Daaruit wordt het interne id gemaakt; dat blijft later gelijk."
    : ""}
>
  <input id="skName" type="text" maxlength="60" bind:value={name} use:focus />
</Field>
<Field
  label={type === "webhook"
    ? "Wanneer gebruikt NOVA dit?"
    : "Waar is dit voor?"}
  id="skDescription"
  help={type === "webhook"
    ? "Dit leest het taalmodel om te kiezen of het deze aanroep gebruikt. Wees specifiek."
    : "Een korte omschrijving; helpt NOVA de juiste vaardigheid te kiezen."}
>
  <input
    id="skDescription"
    type="text"
    maxlength="300"
    bind:value={description}
  />
</Field>
<Field
  label="Zo vraag je het (een zin per regel)"
  id="skExamples"
  help="Voorbeelden zoals je ze hardop zegt. Ze verschijnen in “Vaardigheden” en helpen NOVA de vraag herkennen."
>
  <textarea id="skExamples" rows="3" bind:value={examples}></textarea>
</Field>

{#if type === "instruction"}
  <Field
    label="Instructies"
    id="skInstructions"
    help="Schrijf stappen in gewone taal. NOVA voert ze uit met zijn bestaande gereedschappen en vraagt bevestiging waar die dat eisen."
  >
    <textarea id="skInstructions" rows="7" bind:value={instructions}></textarea>
  </Field>
{:else}
  <div class="grid2">
    <Field label="Methode" id="skMethod">
      <select id="skMethod" bind:value={method}>
        {#each ["GET", "POST", "PUT", "PATCH", "DELETE"] as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </Field>
    <Field
      label="URL"
      id="skUrl"
      help="Zet {'{parameternaam}'} waar een waarde moet komen. Waarden worden veilig ingevuld."
    >
      <input
        id="skUrl"
        type="text"
        placeholder="https://dienst.example/api/{'{naam}'}"
        bind:value={url}
      />
    </Field>
  </div>

  <h3>Parameters</h3>
  <p class="hint">
    Wat NOVA bij het aanroepen mag invullen. De naam gebruik je als {"{naam}"} in
    de URL, headers of body.
  </p>
  <div>
    {#each params as row, index (row.key)}
      <div class="rep-row">
        <input
          type="text"
          placeholder="naam"
          aria-label="Parameternaam"
          data-f="name"
          bind:value={row.name}
        />
        <select aria-label="Soort" data-f="type" bind:value={row.type}>
          <option value="string">tekst</option>
          <option value="number">getal</option>
          <option value="integer">geheel getal</option>
          <option value="boolean">ja/nee</option>
        </select>
        <input
          type="text"
          placeholder="uitleg voor NOVA, bijv. “open of dicht”"
          aria-label="Uitleg"
          data-f="description"
          bind:value={row.description}
        />
        <label>
          <input
            type="checkbox"
            data-f="required"
            bind:checked={row.required}
          />
          verplicht
        </label>
        <Button
          aria-label="Parameter verwijderen"
          onclick={() => params.splice(index, 1)}>×</Button
        >
        <input
          type="text"
          placeholder="keuzes, komma-gescheiden (optioneel)"
          aria-label="Keuzes"
          data-f="enum"
          style="grid-column: 1 / -1"
          bind:value={row.choices}
        />
      </div>
    {/each}
  </div>
  <Button onclick={() => params.push(paramRow())}>Parameter toevoegen</Button>

  <h3>Headers</h3>
  <div>
    {#each headers as row, index (row.key)}
      <div class="rep-row header" data-secret={row.secret ? "1" : undefined}>
        <input
          type="text"
          placeholder={row.secret ? "Authorization" : "Headernaam"}
          aria-label="Headernaam"
          data-f="name"
          bind:value={row.name}
        />
        {#if row.secret}
          <input
            type="password"
            autocomplete="off"
            placeholder={row.stored
              ? "opgeslagen: leeg laten om te behouden"
              : "geheime waarde"}
            aria-label="Waarde"
            data-f="value"
            bind:value={row.value}
          />
        {:else}
          <input
            type="text"
            autocomplete="off"
            placeholder="waarde"
            aria-label="Waarde"
            data-f="value"
            bind:value={row.value}
          />
        {/if}
        <Badge text={row.secret ? "geheim" : "header"} />
        <Button
          aria-label="Header verwijderen"
          onclick={() => headers.splice(index, 1)}>×</Button
        >
      </div>
    {/each}
  </div>
  <div class="set-toolbar">
    <Button onclick={() => headers.push(headerRow({}, false))}
      >Header toevoegen</Button
    >
    <Button onclick={() => headers.push(headerRow({}, true))}
      >Geheime header toevoegen</Button
    >
  </div>
  <p class="hint">
    Een geheime header (bijv. Authorization) wordt versleuteld opgeslagen op de
    server en nooit meer getoond.
  </p>

  <Field
    label="Body (optioneel)"
    id="skBody"
    help="Voor POST, PUT en PATCH. JSON mag; waarden worden veilig ingevuld."
  >
    <textarea
      id="skBody"
      rows="4"
      placeholder={'{"actie": "{actie}"}'}
      bind:value={body}></textarea>
  </Field>
  <div class="grid2">
    <Field
      label="Antwoord: pad (optioneel)"
      id="skExtract"
      help="Alleen dit deel van het antwoord gaat naar NOVA."
    >
      <input
        id="skExtract"
        type="text"
        placeholder="bijv. data.items[0].naam"
        bind:value={extract}
      />
    </Field>
    <Field label="Time-out (seconden)" id="skTimeout">
      <input
        id="skTimeout"
        type="number"
        min="1"
        max="30"
        bind:value={timeout}
      />
    </Field>
  </div>
  <Field
    label="Wat gebeurt er bij aanroepen?"
    id="skRisk"
    help="“Eerst bevestiging vragen” gebruikt dezelfde bevestiging als bij het herstarten van een VM. Kies dit voor alles wat iets verandert."
  >
    <select id="skRisk" bind:value={risk}>
      <option value="READ_ONLY">Alleen lezen</option>
      <option value="SAFE">Direct uitvoeren</option>
      <option value="CONFIRM">Eerst bevestiging vragen</option>
    </select>
  </Field>
  <div class="field">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label>Lokaal netwerk toestaan</label>
    <Toggle bind:checked={allowPrivate} label="Lokaal netwerk toestaan" />
    <p class="help">
      Aan: de aanroep mag een apparaat in je eigen netwerk bereiken (bijv.
      192.168.x.x). Uit: alleen openbare websites. NOVA's eigen onderdelen (API,
      Node-RED, broker) en cloud-metadata zijn altijd geblokkeerd.
    </p>
  </div>
{/if}

<div class="field">
  <!-- svelte-ignore a11y_label_has_associated_control -->
  <label>Staat aan</label>
  <Toggle bind:checked={enabled} label="Staat aan" />
</div>

<div class="editor-actions">
  <Button go onclick={save}>Opslaan</Button>
  <Button onclick={openTest}>Test</Button>
  <Button onclick={() => (tool = "improve")}>Verbeter met NOVA</Button>
  {#if !isNew && type === "webhook"}
    <Button onclick={() => (tool = "runs")}>Recente aanroepen</Button>
  {/if}
  <Button
    onclick={() => {
      settings.editing = null;
      say("");
    }}>Annuleren</Button
  >
  {#if !isNew}
    <Button onclick={remove}
      >{sure ? "Zeker weten? Nogmaals klikken" : "Verwijderen"}</Button
    >
  {/if}
</div>

<div>
  {#if tool === "test"}
    <SkillTestPanel {type} draft={testDraft} {read} />
  {:else if tool === "improve"}
    <SkillImprovePanel {type} {read} {apply} />
  {:else if tool === "runs" && skill}
    <SkillRunsPanel id={skill.id} />
  {/if}
</div>

<style>
  .field {
    margin: 0 0 14px;
  }

  .field > label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--mist);
  }

  .help {
    margin: 5px 0 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--dim);
  }
</style>
