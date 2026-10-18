<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import AbilitiesTab from "#components/settings/AbilitiesTab.svelte";
  import AdvancedPage from "#components/settings/AdvancedPage.svelte";
  import AutonomySection from "#components/settings/AutonomySection.svelte";
  import BackupSection from "#components/settings/BackupSection.svelte";
  import BehaviorTab from "#components/settings/BehaviorTab.svelte";
  import ConversationSection from "#components/settings/ConversationSection.svelte";
  import DevicesSection from "#components/settings/DevicesSection.svelte";
  import DocumentsLibrary from "#components/settings/DocumentsLibrary.svelte";
  import GettingStarted from "#components/settings/GettingStarted.svelte";
  import MemorySection from "#components/settings/MemorySection.svelte";
  import ModelsGuide from "#components/settings/ModelsGuide.svelte";
  import ModelDetails from "#components/settings/ModelDetails.svelte";
  import WindowsSettings from "#components/settings/WindowsSettings.svelte";
  import IntegrationsPage from "#components/settings/IntegrationsPage.svelte";
  import ObjectivesSection from "#components/settings/ObjectivesSection.svelte";
  import QuickActionsEditor from "#components/settings/QuickActionsEditor.svelte";
  import SoundSection from "#components/settings/SoundSection.svelte";
  import TelephonySection from "#components/settings/TelephonySection.svelte";
  import { stopMicTest } from "#components/settings/mic-test.ts";
  import {
    message,
    reload,
    resetState,
    say,
    settings,
  } from "#components/settings/state.svelte.ts";
  import {
    MAIN_PAGES,
    TOPICS,
    pageInfo,
    resolveSettingsTarget,
    searchSettings,
    topicHref,
    type SettingsTopic,
  } from "#components/settings/sections.ts";
  import { partStatus, type PartStatus } from "#components/settings/status.ts";
  import Disclosure from "#components/settings/ui/Disclosure.svelte";
  import StatusPill from "#components/settings/ui/StatusPill.svelte";
  import "#lib/chat/ask.ts";
  import "#components/settings/settings.css";
  import "./settings-page.css";

  let query = $state("");
  const requested = $derived(page.url.searchParams.get("section"));
  const target = $derived(resolveSettingsTarget(requested, page.url.hash));
  const section = $derived(target.page);
  const current = $derived(pageInfo(section));
  let status = $state<PartStatus | null>(null);
  const matches = $derived(searchSettings(query));

  /** The one topic whose state is worth a pill next to the page title. */
  const STATUS_TOPIC: Partial<Record<string, SettingsTopic>> = {
    huis: "connections",
    windows: "desktop",
    telefoon: "telephony",
    zelf: "autonomy",
  };

  // Old links (`?section=voice`, `?section=system#actielog`) land on the page
  // that holds the setting now, and keep pointing at the right block.
  $effect(() => {
    const raw = requested;
    const wanted = untrack(() => resolveSettingsTarget(raw, page.url.hash));
    if (raw === wanted.page && !(wanted.anchor && !page.url.hash)) return;
    const hash = page.url.hash || (wanted.anchor ? `#${wanted.anchor}` : "");
    const params = new SvelteURLSearchParams(page.url.search);
    params.set("section", wanted.page);
    void goto(`/settings?${params}${hash}`, { replaceState: true });
  });

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
    const topic = STATUS_TOPIC[section];
    const data = settings.data;
    status = null;
    if (!topic || !data) return;
    let live = true;
    void partStatus(
      topic,
      untrack(() => data),
    ).then((next) => {
      if (live) status = next;
    });
    return () => {
      live = false;
    };
  });

  /** A link to something inside a closed area opens that area first. */
  function revealHash(): void {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    let target = document.getElementById(id);
    if (!target) {
      const holders = [
        ...document.querySelectorAll("details[data-anchors]"),
      ].filter((node) =>
        node.getAttribute("data-anchors")?.split(" ").includes(id),
      );
      for (const holder of holders)
        if (holder instanceof HTMLDetailsElement) holder.open = true;
      target = document.getElementById(id);
    }
    if (!target) return;
    for (let node: HTMLElement | null = target; node; node = node.parentElement)
      if (node instanceof HTMLDetailsElement) node.open = true;
    target.scrollIntoView({ block: "start" });
  }

  $effect(() => {
    void section;
    void page.url.hash;
    if (!settings.data) return;
    const timers = [50, 400, 1200].map((ms) => setTimeout(revealHash, ms));
    return () => timers.forEach(clearTimeout);
  });

  onMount(() => {
    void reload();
    return () => {
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
              void goto(topicHref(matches[0]));
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
              <a href={topicHref(item)} onclick={() => (query = "")}
                ><span>{item.name}</span><small
                  >{pageInfo(item.page).name}</small
                ></a
              >
            {/each}
            {#if !matches.length}<p role="status">
                Geen instelling gevonden. Probeer een ander woord.
              </p>{/if}
          </nav>
        {:else}
          <nav class="settings-groups" aria-label="Instellingen">
            {#each MAIN_PAGES as item (item.id)}
              <a
                href="/settings?section={item.id}"
                data-group={item.id}
                aria-current={section === item.id ? "page" : undefined}
                >{item.name}</a
              >
            {/each}
            <a
              class="settings-expert-link"
              href="/settings?section=geavanceerd"
              data-group="geavanceerd"
              aria-current={section === "geavanceerd" ? "page" : undefined}
              >Geavanceerd</a
            >
          </nav>
        {/if}
      </div>
    </aside>
    <main class="settings-content" id="settingsBody">
      <div class="settings-title">
        <h1>{current.name}</h1>
        {#if status}<StatusPill tone={status.tone} label={status.label} />{/if}
      </div>
      <p class="settings-intro">{current.detail}</p>
      {#if settings.data && section !== "geavanceerd"}
        <nav class="settings-parts" aria-label="Op deze pagina">
          {#each TOPICS.filter((topic) => topic.page === section && topic.anchor) as topic (topic.id)}
            <a href={topicHref(topic)}>{topic.name}</a>
          {/each}
        </nav>
      {/if}
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
      {#if settings.data}
        {#key section}
          {#if section === "gesprek"}
            <Disclosure
              title="Stem en geluid"
              hint="Stem, volume en microfoon"
              id="stem"
              group="settings-section"><SoundSection /></Disclosure
            >
            <Disclosure
              title="Praten met NOVA"
              hint="Luisteren, reageren en onderbreken"
              id="gesprekken"
              group="settings-section"><ConversationSection /></Disclosure
            >
            <Disclosure
              title="Persoonlijkheid"
              hint="Naam, toon en huishoudprofielen"
              id="persoonlijkheid"
              anchors="persona-history"
              group="settings-section"
              ><BehaviorTab part="persona" /></Disclosure
            >
            <Disclosure
              title="Snelle opdrachten"
              hint="Knoppen op het beginscherm"
              id="snelle-opdrachten"
              group="settings-section"><QuickActionsEditor /></Disclosure
            >
            <Disclosure
              title="App installeren"
              hint="NOVA openen op dit apparaat"
              id="app-installeren"
              group="settings-section"><DevicesSection part="app" /></Disclosure
            >
            <Disclosure
              title="Aan de slag"
              hint="Hulp bij je eerste instellingen"
              group="settings-section"><GettingStarted /></Disclosure
            >
          {:else if section === "huis"}
            <IntegrationsPage />
          {:else if section === "windows"}
            <WindowsSettings />
          {:else if section === "telefoon"}
            <TelephonySection />
          {:else if section === "modellen"}
            <ModelsGuide />
            <ModelDetails />
          {:else if section === "zelf"}
            <Disclosure
              title="Zelfstandigheid"
              hint="Lopende en geplande taken"
              id="taken"
              group="settings-section"><AutonomySection /></Disclosure
            >
            <Disclosure
              title="Functies"
              hint="Functies aan- of uitzetten"
              id="wat-mag"
              group="settings-section"
              ><AbilitiesTab
                close={() => {
                  void goto("/");
                }}
              /></Disclosure
            >
            <Disclosure
              title="Uitvoering en actielog"
              hint="NOVA handelt direct en registreert acties"
              id="toestemmingen"
              group="settings-section"
            >
              <p>
                NOVA voert acties direct uit en rapporteert achteraf. Je kunt
                een taak stoppen of een functie uitzetten.
              </p>
              <a href="/settings?section=geavanceerd#actielog"
                >Actielog bekijken</a
              >
            </Disclosure>
            <Disclosure
              title="Doelen"
              hint="Waar NOVA op moet letten"
              id="doelen"
              group="settings-section"><ObjectivesSection /></Disclosure
            >
          {:else if section === "geheugen"}
            <Disclosure
              title="Geheugen en privacy"
              hint="Onthouden, zoeken en verwijderen"
              group="settings-section"><MemorySection /></Disclosure
            >
            <Disclosure
              title="Documenten"
              hint="Bestanden die NOVA mag gebruiken"
              id="documenten"
              group="settings-section"><DocumentsLibrary /></Disclosure
            >
            <Disclosure
              title="Back-up en herstel"
              hint="Instellingen bewaren en terugzetten"
              id="backup"
              group="settings-section"><BackupSection /></Disclosure
            >
          {:else if section === "geavanceerd"}
            <AdvancedPage />
          {/if}
        {/key}
      {:else}
        <p>Instellingen laden…</p>
        <button type="button" onclick={() => reload()}>Opnieuw proberen</button>
      {/if}
    </main>
  </div>
</div>
