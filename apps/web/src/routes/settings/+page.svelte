<script lang="ts">
  import ToolUsage from "#components/settings/ToolUsage.svelte";
  import WorkspaceProjects from "#components/settings/WorkspaceProjects.svelte";
  import StackControl from "#components/settings/StackControl.svelte";
  import McpStatus from "#components/settings/McpStatus.svelte";
  import FreePolicyWizard from "#components/settings/FreePolicyWizard.svelte";
  import InstallationWizard from "#components/settings/InstallationWizard.svelte";
  import OmniRouteAccounts from "#components/settings/OmniRouteAccounts.svelte";
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import ConnectionsSection from "#components/settings/ConnectionsSection.svelte";
  import ConnectionHistory from "#components/settings/ConnectionHistory.svelte";
  import HelperPreferencesHistory from "#components/settings/HelperPreferencesHistory.svelte";
  import ToolSwitchHistory from "#components/settings/ToolSwitchHistory.svelte";
  import SidebarHistory from "#components/settings/SidebarHistory.svelte";
  import ModelMetrics from "#components/settings/ModelMetrics.svelte";
  import NativeGateway from "#components/settings/NativeGateway.svelte";
  import UpdatesSection from "#components/settings/UpdatesSection.svelte";
  import DesktopSection from "#components/settings/DesktopSection.svelte";
  import WindowsAgentPanel from "#components/settings/WindowsAgentPanel.svelte";
  import AbilitiesTab from "#components/settings/AbilitiesTab.svelte";
  import SkillsTab from "#components/settings/SkillsTab.svelte";
  import SidebarTab from "#components/settings/SidebarTab.svelte";
  import BehaviorTab from "#components/settings/BehaviorTab.svelte";
  import SoundSection from "#components/settings/SoundSection.svelte";
  import DevicesSection from "#components/settings/DevicesSection.svelte";
  import BackupSection from "#components/settings/BackupSection.svelte";
  import QuickActionsEditor from "#components/settings/QuickActionsEditor.svelte";
  import ToolsList from "#components/settings/ToolsList.svelte";
  import AdminDialog from "#components/admin/AdminDialog.svelte";
  import DocumentsLibrary from "#components/settings/DocumentsLibrary.svelte";
  import { stopMicTest } from "#components/settings/mic-test.ts";
  import {
    message,
    reload,
    resetState,
    say,
    settings,
    unlock,
  } from "#components/settings/state.svelte.ts";
  import {
    SECTIONS,
    settingsSection,
    searchSettings,
    SETTINGS_GROUPS,
    FREQUENT_SECTIONS,
  } from "#components/settings/sections.ts";
  import { getPin, setPin } from "#lib/api/settings.ts";
  import "#lib/chat/ask.ts";
  import "#components/settings/settings.css";
  import "./settings-page.css";

  let query = $state("");
  let pin = $state("");
  const section = $derived(
    settingsSection(page.url.searchParams.get("section")),
  );
  const current = $derived(SECTIONS.find((item) => item.id === section)!);
  const matches = $derived(searchSettings(query));

  $effect(() => {
    // Reading the section resets only unsaved editors, never persisted settings.
    void section;
    untrack(() => {
      resetState();
      stopMicTest();
      say("");
    });
  });

  onMount(() => {
    void reload();
    const timeout = setInterval(() => {
      if (settings.data?.pinRequired && !settings.needPin && !getPin()) {
        settings.data = null;
        void reload();
      }
    }, 1000);
    return () => {
      clearInterval(timeout);
      stopMicTest();
      resetState();
    };
  });
</script>

<svelte:head><title>Instellingen · NOVA</title></svelte:head>

<div class="settings-page" id="settingsDialog">
  <header class="settings-heading">
    <a href="/" class="settings-home">NOVA</a>
    <span>Instellingen</span>
    <a href="/" class="settings-back">Terug naar gesprek</a>
  </header>
  <div class="settings-layout">
    <aside class="settings-sidebar">
      <form
        class="settings-search"
        role="search"
        onsubmit={(event) => {
          event.preventDefault();
          if (matches[0]) {
            void goto(`/settings?section=${matches[0].id}`);
            query = "";
          }
        }}
      >
        <label for="settingsSearch">Zoek een instelling</label>
        <input
          id="settingsSearch"
          type="search"
          placeholder="Stem, model, back-up…"
          bind:value={query}
        />
      </form>
      <label class="settings-mobile-label" for="settingsSection">Ga naar</label>
      <select
        class="settings-mobile-select"
        id="settingsSection"
        value={section}
        onchange={(event) =>
          void goto(`/settings?section=${event.currentTarget.value}`)}
      >
        {#each SETTINGS_GROUPS as group (group.name)}
          <optgroup label={group.name}>
            {#each SECTIONS.filter((item) => FREQUENT_SECTIONS.has(item.id) === group.frequent) as item (item.id)}
              <option value={item.id}>{item.name}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
      <nav aria-label="Instellingen">
        {#each SETTINGS_GROUPS as group (group.name)}
          {@const items = matches.filter(
            (item) => FREQUENT_SECTIONS.has(item.id) === group.frequent,
          )}
          {#if items.length}
            <div class="settings-nav-group">
              <h2>{query.trim() ? "Zoekresultaten" : group.name}</h2>
              {#each items as item (item.id)}
                <a
                  href="/settings?section={item.id}"
                  aria-current={section === item.id ? "page" : undefined}
                  >{item.name}</a
                >
              {/each}
            </div>
          {/if}
        {/each}
        {#if !matches.length}<p role="status">
            Geen instelling gevonden. Probeer een ander woord.
          </p>{/if}
      </nav>
    </aside>
    <main class="settings-content" id="settingsBody">
      <h1>{current.name}</h1>
      <p class="settings-intro">{current.detail}</p>
      <div
        id="settingsMessage"
        role="status"
        class={message.kind}
        hidden={!message.text}
      >
        {message.text}
        {#if message.details.length}<ul>
            {#each message.details as detail (detail)}<li>{detail}</li>{/each}
          </ul>{/if}
      </div>
      {#if settings.data?.pinRequired && !settings.needPin}
        <button
          type="button"
          class="settings-lock"
          onclick={() => {
            setPin("");
            settings.data = null;
            void reload();
          }}>Instellingen vergrendelen</button
        >
      {/if}
      {#if settings.needPin}
        <form
          class="settings-unlock"
          onsubmit={(event) => {
            event.preventDefault();
            void unlock(pin).then(() => (pin = ""));
          }}
        >
          <label for="pinInput">PIN om instellingen te openen</label>
          <input
            id="pinInput"
            type="password"
            autocomplete="off"
            bind:value={pin}
          />
          <button type="submit">Ontgrendelen</button>
        </form>
      {:else if settings.data}
        {#key section}
          {#if section === "setup"}<InstallationWizard />
          {:else if section === "general"}
            <h2>Snelle opdrachten</h2>
            <QuickActionsEditor />
            <h2>Zijbalk en informatiepanelen</h2>
            <SidebarTab />
          {:else if section === "voice"}<SoundSection />
          {:else if section === "personality"}<BehaviorTab part="persona" />
          {:else if section === "abilities"}
            <AbilitiesTab
              close={() => {
                void goto("/");
              }}
            />
            <ToolUsage />
            <BehaviorTab part="approvals" />
            <details>
              <summary>Alle gereedschappen en hun risico</summary><ToolsList />
            </details>
          {:else if section === "skills"}<SkillsTab />
          {:else if section === "code"}<WorkspaceProjects />
          {:else if section === "models"}
            <ConnectionsSection ids={["omniroute"]} />
            <ModelMetrics />
            <OmniRouteAccounts />
            <FreePolicyWizard />
            <NativeGateway />
            <AdminDialog embedded initialView="providers" />
            <h2>OmniRoute</h2>
            <AdminDialog embedded initialView="gateway" />
          {:else if section === "services"}
            <StackControl />
            <McpStatus />
          {:else if section === "connections"}
            <ConnectionsSection
              ids={[
                "home-assistant",
                "proxmox",
                "qdrant",
                "mqtt",
                "node-red",
                "termix",
                "pangolin",
              ]}
            />
            <McpStatus />
            <AdminDialog embedded initialView="integrations" />
          {:else if section === "devices"}<ConnectionsSection
              ids={["windows"]}
            />
            <WindowsAgentPanel />
            <DevicesSection />
          {:else if section === "desktop"}<DesktopSection />
          {:else if section === "memory"}<AdminDialog
              embedded
              initialView="memories"
            />
            <DocumentsLibrary />
          {:else if section === "documents"}<DocumentsLibrary />
          {:else if section === "safety"}<BehaviorTab part="approvals" />
          {:else if section === "system"}
            <UpdatesSection />
            <ConnectionHistory />
            <HelperPreferencesHistory />
            <ToolSwitchHistory />
            <SidebarHistory />
            <BackupSection />
            <h2 id="actielog">Actielog</h2>
            <AdminDialog embedded initialView="audit" />
          {:else if section === "automation"}
            <ConnectionsSection ids={["node-red"]} />
          {/if}
        {/key}
      {:else}
        <p>Instellingen laden…</p>
        <button type="button" onclick={() => reload()}>Opnieuw proberen</button>
      {/if}
    </main>
  </div>
</div>
