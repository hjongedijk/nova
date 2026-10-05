<script lang="ts">
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import AbilitiesTab from "./AbilitiesTab.svelte";
  import SkillsTab from "./SkillsTab.svelte";
  import SidebarTab from "./SidebarTab.svelte";
  import BehaviorTab from "./BehaviorTab.svelte";
  import MoreTab from "./MoreTab.svelte";
  import { stopMicTest } from "./mic-test.ts";
  import {
    message,
    reload,
    resetState,
    say,
    settings,
    unlock,
    type Tab,
  } from "./state.svelte.ts";
  import "./settings.css";

  const TABS: [Tab, string][] = [
    ["abilities", "Wat NOVA kan"],
    ["skills", "Eigen vaardigheden"],
    ["sidebar", "Zijbalk"],
    ["behavior", "Gedrag"],
    ["more", "Meer"],
  ];

  let dialog: HTMLDialogElement | undefined = $state();
  let pin = $state("");

  // The menu sets dialogs.settings; this component shows the native dialog and tells the store when it is closed.
  $effect(() => {
    if (!dialog) return;
    if (dialogs.settings && !dialog.open) {
      const wanted = TABS.find(([tab]) => tab === dialogs.settingsTab)?.[0];
      if (wanted) pickTab(wanted);
      dialogs.settingsTab = null;
      dialog.showModal();
      void reload();
    } else if (!dialogs.settings && dialog.open) dialog.close();
  });

  function closed(): void {
    dialogs.settings = false;
    stopMicTest();
  }

  function pickTab(tab: Tab): void {
    settings.tab = tab;
    resetState();
    say("");
  }
</script>

<dialog
  id="settingsDialog"
  bind:this={dialog}
  aria-labelledby="settingsTitle"
  onclose={closed}
>
  <div class="admin-heading">
    <h2 id="settingsTitle">Instellingen</h2>
    <Button id="settingsClose" onclick={() => dialog?.close()}>Sluiten</Button>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <nav class="tabs" id="settingsTabs" role="tablist" aria-label="Instellingen">
    {#each TABS as [tab, name] (tab)}
      <button
        type="button"
        role="tab"
        data-tab={tab}
        aria-selected={settings.tab === tab}
        onclick={() => pickTab(tab)}
      >
        {name}
      </button>
    {/each}
  </nav>
  <div
    id="settingsMessage"
    role="status"
    class={message.kind}
    data-n={message.n}
  >
    {message.text}
    {#if message.details.length}
      <ul>
        {#each message.details as detail (detail)}<li>{detail}</li>{/each}
      </ul>
    {/if}
  </div>
  <div id="settingsBody">
    {#if !dialogs.settings}
      <!-- closed: nothing is drawn -->
    {:else if settings.needPin}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void unlock(pin).then(() => (pin = ""));
        }}
      >
        <p class="hint">Voor de instellingen is een PIN ingesteld.</p>
        <Field label="PIN" id="pinInput">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="password"
            id="pinInput"
            autocomplete="off"
            autofocus
            bind:value={pin}
          />
        </Field>
        <Button type="submit">Ontgrendelen</Button>
      </form>
    {:else if settings.data}
      {#if settings.tab === "abilities"}
        <AbilitiesTab close={() => dialog?.close()} />
      {:else if settings.tab === "skills"}
        <SkillsTab />
      {:else if settings.tab === "sidebar"}
        <SidebarTab />
      {:else if settings.tab === "behavior"}
        <BehaviorTab />
      {:else}
        <MoreTab />
      {/if}
    {/if}
  </div>
</dialog>
