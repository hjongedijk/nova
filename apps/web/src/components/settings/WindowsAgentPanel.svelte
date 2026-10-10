<script lang="ts">
  import { onMount } from "svelte";
  import type { WindowsAgentStatus } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getHelperHotkeys,
    saveHelperHotkeys,
    getWindowsAgentStatus,
  } from "#lib/api/settings.ts";
  const keys = [
    { id: "open", label: "Openen" },
    { id: "speak", label: "Spreken" },
    { id: "mute", label: "Dempen" },
    { id: "desktop", label: "Bureaublad" },
  ];
  let status = $state<WindowsAgentStatus | null>(null);
  let hotkeys = $state<Record<string, string>>({});
  let busy = $state(false);
  let ready = $state(false);
  let note = $state("");
  const warnings = (value: unknown): string =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .slice(0, 5)
          .map((item) => item.slice(0, 200))
          .join(" · ")
      : "";
  async function refresh() {
    busy = true;
    ready = false;
    note = "";
    try {
      const [agent, shortcuts] = await Promise.allSettled([
        getWindowsAgentStatus(),
        getHelperHotkeys(),
      ]);
      status = agent.status === "fulfilled" ? agent.value : null;
      if (
        shortcuts.status === "fulfilled" &&
        shortcuts.value.ok &&
        shortcuts.value.preferences &&
        keys.every(
          (key) =>
            typeof shortcuts.value.preferences?.hotkeys?.[key.id] === "string",
        )
      ) {
        hotkeys = { ...shortcuts.value.preferences.hotkeys };
        ready = true;
        note = warnings(shortcuts.value.preferences.warnings);
      } else
        note =
          "Sneltoetsen zijn niet beschikbaar. Controleer de verbinding of werk de agent bij.";
      if (!status)
        note = "De agentstatus kon niet worden geladen. Probeer opnieuw.";
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (!ready || busy) return;
    busy = true;
    note = "";
    try {
      const result = await saveHelperHotkeys(
        Object.fromEntries(keys.map((key) => [key.id, hotkeys[key.id] ?? ""])),
      );
      if (
        result.ok &&
        result.preferences &&
        keys.every(
          (key) => typeof result.preferences?.hotkeys?.[key.id] === "string",
        )
      ) {
        hotkeys = { ...result.preferences.hotkeys };
        note =
          warnings(result.preferences.warnings) ||
          "Sneltoetsen opgeslagen op de Windows-pc.";
      } else
        note =
          "De agent bevestigt de sneltoetsen niet. Vernieuw de status en controleer de pc.";
    } catch {
      note =
        "Sneltoetsen zijn niet opgeslagen. Controleer de verbinding of de beheer-PIN.";
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void refresh();
  });
</script>

<section class="windows-agent-panel" aria-label="Windows-agentstatus">
  <h2>Windows-agent en helper</h2>
  <Button onclick={refresh} disabled={busy}>Status vernieuwen</Button>
  {#if status?.available}
    <dl>
      <dt>Agentversie</dt>
      <dd>{status.version ?? "Onbekend; werk de agent bij"}</dd>
      <dt>Helpervenster</dt>
      <dd>
        {status.helperOpen === null
          ? "Onbekend"
          : status.helperOpen
            ? "Open"
            : "Gesloten"}
      </dd>
      <dt>Gepauzeerd</dt>
      <dd>
        {status.paused === null ? "Onbekend" : status.paused ? "Ja" : "Nee"}
      </dd>
      <dt>Modus op de pc</dt>
      <dd>
        {status.mode
          ? { helper: "Helper", wallpaper: "Achtergrond", both: "Beide" }[
              status.mode
            ]
          : "Onbekend"}
      </dd>
      <dt>Helper op scherm</dt>
      <dd>
        {status.display === null
          ? "Onbekend"
          : status.display === 0
            ? "Hoofdscherm"
            : status.display}
      </dd>
    </dl>
  {:else if status}<p>{status.error}</p>{/if}
  <details>
    <summary>Sneltoetsen op de Windows-pc</summary>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) void save();
      }}
    >
      <fieldset disabled={busy || !ready}>
        {#each keys as key (key.id)}<label
            >{key.label}<input
              aria-label={`Sneltoets ${key.label}`}
              bind:value={hotkeys[key.id]}
              maxlength={80}
            /></label
          >{/each}
        <Button type="submit">Sneltoetsen opslaan</Button>
      </fieldset>
    </form>
  </details>
  {#if note}<p role="status">{note}</p>{/if}
</section>

<style>
  .windows-agent-panel {
    margin: 1.5rem 0;
  }
  dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem;
  }
  dt,
  p {
    color: #a4bacd;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  fieldset {
    border: 0;
    padding: 1rem 0;
  }
  label {
    display: grid;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  input {
    width: 100%;
    padding: 0.75rem;
    color: #e4edf6;
    background: #132538;
    border: 1px solid #30465a;
  }
</style>
