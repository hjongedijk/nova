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
  import ModelRoles from "#components/settings/ModelRoles.svelte";
  import ModelMetrics from "#components/settings/ModelMetrics.svelte";
  import NativeGateway from "#components/settings/NativeGateway.svelte";
  import UpdatesSection from "#components/settings/UpdatesSection.svelte";
  import DesktopSection from "#components/settings/DesktopSection.svelte";
  import ConversationSection from "#components/settings/ConversationSection.svelte";
  import AutonomySection from "#components/settings/AutonomySection.svelte";
  import WindowsAgentPanel from "#components/settings/WindowsAgentPanel.svelte";
  import AbilitiesTab from "#components/settings/AbilitiesTab.svelte";
  import SkillsTab from "#components/settings/SkillsTab.svelte";
  import SidebarTab from "#components/settings/SidebarTab.svelte";
  import BehaviorTab from "#components/settings/BehaviorTab.svelte";
  import SoundSection from "#components/settings/SoundSection.svelte";
  import TelephonySection from "#components/settings/TelephonySection.svelte";
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
    GROUPS,
    GROUP_OF,
    groupInfo,
    sectionInfo,
    settingsSection,
    searchSettings,
  } from "#components/settings/sections.ts";
  import { partStatus, type PartStatus } from "#components/settings/status.ts";
  import Disclosure from "#components/settings/ui/Disclosure.svelte";
  import HistoryGroup from "#components/settings/ui/HistoryGroup.svelte";
  import StatusPill from "#components/settings/ui/StatusPill.svelte";
  import { getPin, setPin } from "#lib/api/settings.ts";
  import "#lib/chat/ask.ts";
  import "#components/settings/settings.css";
  import "./settings-page.css";

  let query = $state("");
  let pin = $state("");
  const section = $derived(
    settingsSection(page.url.searchParams.get("section")),
  );
  const current = $derived(sectionInfo(section));
  const group = $derived(groupInfo(GROUP_OF[section]));
  let status = $state<PartStatus | null>(null);
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

  $effect(() => {
    const id = section;
    const data = settings.data;
    if (!data) return;
    status = null;
    let current = true;
    void partStatus(
      id,
      untrack(() => data),
    ).then((next) => {
      if (current) status = next;
    });
    return () => {
      current = false;
    };
  });

  /** Old deep links to histories that now live next to the setting they belong to. */
  const HISTORY_HOME: Record<string, string> = {
    "sidebar-history": "general",
    "tool-switch-history": "abilities",
  };

  /** A link to something inside a closed area (Geavanceerd, history) opens that area. */
  function revealHash(): void {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    const home = HISTORY_HOME[id];
    if (home && section === "system") {
      void goto(`/settings?section=${home}#${id}`, { replaceState: true });
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    for (let node: HTMLElement | null = target; node; node = node.parentElement)
      if (node instanceof HTMLDetailsElement) node.open = true;
    target.scrollIntoView({ block: "start" });
  }

  $effect(() => {
    void section;
    if (!settings.data) return;
    const timers = [50, 400, 1200].map((ms) => setTimeout(revealHash, ms));
    return () => timers.forEach(clearTimeout);
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
      <div class="settings-sidebar-inner">
        <form
          class="settings-search"
          role="search"
          onsubmit={(event) => {
            event.preventDefault();
            if (query.trim() && matches[0]) {
              void goto(`/settings?section=${matches[0].id}`);
              query = "";
            }
          }}
        >
          <label for="settingsSearch">Zoek een instelling</label>
          <input
            id="settingsSearch"
            type="search"
            placeholder="Bijvoorbeeld stem, model of back-up"
            autocomplete="off"
            bind:value={query}
          />
        </form>
        {#if query.trim()}
          <nav class="settings-results" aria-label="Zoekresultaten">
            {#each matches as item (item.id)}
              <a href="/settings?section={item.id}" onclick={() => (query = "")}
                ><span>{item.name}</span><small
                  >{groupInfo(GROUP_OF[item.id]).name}</small
                ></a
              >
            {/each}
            {#if !matches.length}<p role="status">
                Geen instelling gevonden. Probeer een ander woord.
              </p>{/if}
          </nav>
        {:else}
          <nav class="settings-groups" aria-label="Instellingen">
            {#each GROUPS as item (item.id)}
              <a
                href="/settings?section={item.parts[0]}"
                data-group={item.id}
                aria-current={group.id === item.id ? "page" : undefined}
                >{item.name}</a
              >
            {/each}
          </nav>
        {/if}
      </div>
    </aside>
    <main class="settings-content" id="settingsBody">
      {#if group.parts.length > 1}
        <nav class="settings-parts" aria-label="Onderdelen van {group.name}">
          {#each group.parts as part (part)}
            <a
              href="/settings?section={part}"
              aria-current={part === section ? "page" : undefined}
              >{sectionInfo(part).name}</a
            >
          {/each}
        </nav>
      {/if}
      <div class="settings-title">
        <h1>{current.name}</h1>
        {#if status}<StatusPill tone={status.tone} label={status.label} />{/if}
      </div>
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
            <Disclosure
              kind="advanced"
              title="Zijbalk en informatiepanelen"
              hint="Kies welke panelen je ziet en waar"
              id="zijbalk"
            >
              <SidebarTab />
            </Disclosure>
            <HistoryGroup><SidebarHistory /></HistoryGroup>
          {:else if section === "voice"}<SoundSection />
          {:else if section === "personality"}<BehaviorTab part="persona" />
          {:else if section === "abilities"}
            <AbilitiesTab
              close={() => {
                void goto("/");
              }}
            />
            <Disclosure
              kind="advanced"
              title="Geavanceerd"
              hint="Alle gereedschappen, hun risico en gebruik"
            >
              <ToolUsage />
              <ToolsList />
            </Disclosure>
            <HistoryGroup><ToolSwitchHistory /></HistoryGroup>
          {:else if section === "skills"}<SkillsTab />
          {:else if section === "code"}<WorkspaceProjects />
          {:else if section === "models"}
            <ConnectionsSection ids={["omniroute"]} />
            <Disclosure
              title="Model per taak kiezen"
              hint="Bijvoorbeeld een ander model voor code of samenvatten"
              id="modelrollen"
            >
              <ModelRoles />
            </Disclosure>
            <Disclosure
              kind="advanced"
              title="Geavanceerd"
              hint="Metingen, accounts, gratis-beleid, native gateway en aanbieders"
            >
              <ModelMetrics />
              <OmniRouteAccounts />
              <FreePolicyWizard />
              <NativeGateway />
              <AdminDialog embedded initialView="providers" />
              <h2>OmniRoute</h2>
              <AdminDialog embedded initialView="gateway" />
            </Disclosure>
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
            <Disclosure
              kind="advanced"
              title="Geavanceerd"
              hint="MCP-servers en overige integraties"
            >
              <McpStatus />
              <AdminDialog embedded initialView="integrations" />
            </Disclosure>
            <HistoryGroup><ConnectionHistory /></HistoryGroup>
          {:else if section === "devices"}
            <ConnectionsSection ids={["windows"]} />
            <WindowsAgentPanel />
            <DevicesSection />
            <HistoryGroup><HelperPreferencesHistory /></HistoryGroup>
          {:else if section === "desktop"}<DesktopSection />
          {:else if section === "conversation"}<ConversationSection />
          {:else if section === "autonomy"}<AutonomySection />
          {:else if section === "telephony"}<TelephonySection />
          {:else if section === "memory"}
            <AdminDialog embedded initialView="memories" />
          {:else if section === "documents"}<DocumentsLibrary />
          {:else if section === "safety"}<BehaviorTab part="approvals" />
          {:else if section === "system"}
            <UpdatesSection />
            <BackupSection />
            <Disclosure
              kind="advanced"
              title="Actielog"
              hint="Alles wat NOVA heeft gedaan, voor controle"
              id="actielog"
            >
              <AdminDialog embedded initialView="audit" />
            </Disclosure>
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
