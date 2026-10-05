<script lang="ts">
  import { untrack } from "svelte";
  import type { Widget, WidgetInput, WidgetType } from "@nova/contracts";
  import {
    createWidget,
    deleteWidget,
    previewWidget,
    updateWidget,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import Toggle from "#components/ui/Toggle.svelte";
  import { WIDGET_KINDS } from "./labels.ts";
  import { afterChange, fail, settings } from "./state.svelte.ts";

  const props: { type: WidgetType; widget: Widget | null } = $props();
  // The editor is created per panel ({#key} in SidebarTab): it starts from what it is given.
  const { type, widget } = untrack(() => props);

  const kind = WIDGET_KINDS.find((entry) => entry[0] === type);
  const w = (widget ?? { enabled: true }) as Partial<Widget> & {
    source?: { url?: string; extract?: string; allowPrivate?: boolean };
    unit?: string;
    itemPath?: string;
    max?: number;
    refreshMinutes?: number;
    text?: string;
  };

  let title = $state(w.title ?? "");
  let text = $state(w.text ?? "");
  let url = $state(w.source?.url ?? "");
  let extract = $state(w.source?.extract ?? "");
  let unit = $state(w.unit ?? "");
  let itemPath = $state(w.itemPath ?? "");
  let max = $state(String(w.max ?? 5));
  let refresh = $state(String(w.refreshMinutes ?? 15));
  let lan = $state(w.source?.allowPrivate === true);

  type Action = "ask" | "link" | "skill";
  interface ButtonRow {
    key: number;
    label: string;
    action: Action;
    detail: string;
    skillId: string;
    args: Record<string, string | number | boolean>;
  }
  const skillOptions = (settings.data?.skills ?? []).filter(
    (skill) => skill.type === "webhook",
  );
  let nextKey = 0;
  const buttonRow = (
    item: Partial<ButtonRow> & { prompt?: string; url?: string } = {},
  ): ButtonRow => ({
    key: nextKey++,
    label: item.label ?? "",
    action: item.action ?? "ask",
    detail: item.prompt ?? item.url ?? "",
    skillId: item.skillId ?? skillOptions[0]?.id ?? "",
    args: item.args ?? {},
  });
  const initialButtons = (
    widget?.type === "buttons" ? widget.buttons : [{ action: "ask" }]
  ) as Parameters<typeof buttonRow>[0][];
  let buttons = $state<ButtonRow[]>(
    type === "buttons" ? initialButtons.map(buttonRow) : [],
  );

  let preview = $state<string | null>(null);
  let sure = $state(false);

  function read(): WidgetInput {
    const body: WidgetInput = { type, title, enabled: w.enabled !== false };
    if (type === "note") body.text = text;
    if (type === "buttons")
      body.buttons = buttons.map((row) =>
        row.action === "ask"
          ? { label: row.label, action: "ask", prompt: row.detail }
          : row.action === "link"
            ? { label: row.label, action: "link", url: row.detail }
            : {
                label: row.label,
                action: "skill",
                skillId: row.skillId,
                args: $state.snapshot(row.args),
              },
      );
    if (type === "value" || type === "list") {
      body.source = { url, extract, allowPrivate: lan };
      body.refreshMinutes = Number(refresh);
      if (type === "value") body.unit = unit;
      if (type === "list") {
        body.itemPath = itemPath;
        body.max = Number(max);
      }
    }
    return body;
  }

  async function test(): Promise<void> {
    try {
      const { data } = await previewWidget(read());
      preview = data.error
        ? `Dat lukt nog niet: ${data.error}`
        : type === "value"
          ? `Dit zou je zien: ${data.value}${unit ? ` ${unit}` : ""}`
          : `Dit zou je zien:\n${(data.items ?? []).join("\n") || "(leeg)"}`;
    } catch (error) {
      fail(error);
    }
  }

  async function save(): Promise<void> {
    try {
      if (widget) await updateWidget(widget.id, read());
      else await createWidget(read());
      settings.editingWidget = null;
      await afterChange(`“${title.trim()}” staat in de zijbalk.`);
    } catch (error) {
      fail(error);
    }
  }

  async function remove(): Promise<void> {
    if (!widget) return;
    if (!sure) {
      sure = true;
      return;
    }
    try {
      await deleteWidget(widget.id);
      settings.editingWidget = null;
      await afterChange(`“${widget.title}” is verwijderd.`);
    } catch (error) {
      fail(error);
    }
  }

  function focus(node: HTMLElement): void {
    node.focus();
  }
</script>

<h3>
  {widget ? `${widget.title} aanpassen` : `Nieuw paneel: ${kind?.[1] ?? ""}`}
</h3>
<p class="hint">{kind?.[2] ?? ""}</p>

<Field label="Titel" id="wTitle" help="Zo heet het paneel in de zijbalk.">
  <input id="wTitle" type="text" maxlength="40" bind:value={title} use:focus />
</Field>

{#if type === "note"}
  <Field label="Tekst" id="wText">
    <textarea id="wText" rows="4" maxlength="1000" bind:value={text}></textarea>
  </Field>
{/if}

{#if type === "value" || type === "list"}
  <div>
    <Field
      label="Webadres"
      id="wUrl"
      help="Het adres waar de gegevens vandaan komen. Het antwoord moet JSON zijn."
    >
      <input
        id="wUrl"
        type="text"
        maxlength="500"
        placeholder="https://…"
        bind:value={url}
      />
    </Field>
    <Field
      label={type === "value" ? "Welke waarde" : "Waar staat de lijst"}
      id="wExtract"
      help={type === "value"
        ? "Het pad naar de waarde in het antwoord, bijvoorbeeld number of data.temp. Leeg laten als het antwoord zelf de waarde is."
        : "Het pad naar de lijst in het antwoord, bijvoorbeeld articles. Leeg laten als het antwoord zelf een lijst is."}
    >
      <input
        id="wExtract"
        type="text"
        placeholder="bijvoorbeeld number"
        bind:value={extract}
      />
    </Field>
    {#if type === "value"}
      <Field label="Eenheid" id="wUnit" help="Staat achter het getal.">
        <input
          id="wUnit"
          type="text"
          maxlength="12"
          placeholder="bijvoorbeeld mensen"
          bind:value={unit}
        />
      </Field>
    {:else}
      <Field
        label="Wat uit elk item"
        id="wItem"
        help="Welk veld je per regel toont, bijvoorbeeld title."
      >
        <input
          id="wItem"
          type="text"
          maxlength="60"
          placeholder="bijvoorbeeld title"
          bind:value={itemPath}
        />
      </Field>
      <Field label="Hoeveel regels" id="wMax">
        <input id="wMax" type="number" min="1" max="10" bind:value={max} />
      </Field>
    {/if}
    <Field
      label="Verversen (minuten)"
      id="wRefresh"
      help="Hoe vaak NOVA nieuwe gegevens ophaalt."
    >
      <input
        id="wRefresh"
        type="number"
        min="1"
        max="1440"
        bind:value={refresh}
      />
    </Field>
    <label class="check">
      <Toggle
        bind:checked={lan}
        label="Dit adres staat in mijn eigen netwerk"
      />
      Dit adres staat in mijn eigen netwerk
    </label>
    <div class="set-toolbar">
      <Button onclick={test}>Test het adres</Button>
    </div>
    {#if preview !== null}<pre>{preview}</pre>{/if}
  </div>
{/if}

{#if type === "buttons"}
  <div>
    <div>
      {#each buttons as row, index (row.key)}
        <div class="rep-row header">
          <input
            type="text"
            maxlength="30"
            placeholder="Tekst op de knop"
            aria-label="Tekst op de knop"
            bind:value={row.label}
          />
          <select aria-label="Wat doet de knop" bind:value={row.action}>
            <option value="ask">Vraagt NOVA iets</option>
            <option value="link">Opent een link</option>
            {#if skillOptions.length > 0}
              <option value="skill">Voert een vaardigheid uit</option>
            {/if}
          </select>
          {#if row.action === "skill"}
            <select aria-label="Vaardigheid" bind:value={row.skillId}>
              {#each skillOptions as entry (entry.id)}
                <option value={entry.id}>{entry.name}</option>
              {/each}
            </select>
          {:else}
            <input
              type="text"
              maxlength="300"
              aria-label="Wat de knop doet"
              placeholder={row.action === "link"
                ? "https://…"
                : "Wat NOVA moet doen, bijvoorbeeld: Hoe laat is het?"}
              bind:value={row.detail}
            />
          {/if}
          <Button
            aria-label="Knop verwijderen"
            onclick={() => buttons.splice(index, 1)}>×</Button
          >
        </div>
      {/each}
    </div>
    <Button onclick={() => buttons.push(buttonRow())}>Knop toevoegen</Button>
  </div>
{/if}

<div class="set-toolbar">
  <Button go onclick={save}>Opslaan</Button>
  <Button onclick={() => (settings.editingWidget = null)}>Annuleren</Button>
  {#if widget}
    <Button onclick={remove}
      >{sure ? "Zeker weten? Nogmaals klikken" : "Verwijderen"}</Button
    >
  {/if}
</div>
