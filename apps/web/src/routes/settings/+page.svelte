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
  import ConnectionsSection from "#components/settings/ConnectionsSection.svelte";
  import ConversationSection from "#components/settings/ConversationSection.svelte";
  import DesktopSection from "#components/settings/DesktopSection.svelte";
  import DevicesSection from "#components/settings/DevicesSection.svelte";
  import DocumentsLibrary from "#components/settings/DocumentsLibrary.svelte";
  import GettingStarted from "#components/settings/GettingStarted.svelte";
  import MemorySection from "#components/settings/MemorySection.svelte";
  import ModelsGuide from "#components/settings/ModelsGuide.svelte";
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
    unlock,
  } from "#components/settings/state.svelte.ts";
  import {
    MAIN_PAGES,
    pageInfo,
    resolveSettingsTarget,
    searchSettings,
    topicHref,
    type SettingsTopic,
  } from "#components/settings/sections.ts";
  import { partStatus, type PartStatus } from "#components/settings/status.ts";
  import StatusPill from "#components/settings/ui/StatusPill.svelte";
  import { getPin, setPin } from "#lib/api/settings.ts";
  import "#lib/chat/ask.ts";
  import "#components/settings/settings.css";
  import "./settings-page.css";

  let query = $state("");
  let pin = $state("");
  const requested = $derived(page.url.searchParams.get("section"));
  const target = $derived(resolveSettingsTarget(requested, page.url.hash));
  const section = $derived(target.page);
  const current = $derived(pageInfo(section));
  let status = $state<PartStatus | null>(null);
  const matches = $derived(searchSettings(query));

  /** The one topic whose state is worth a pill next to the page title. */
  const STATUS_TOPIC: Partial<Record<string, SettingsTopic>> = {
    huis: "connections",
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
    const params = new SvelteURLSearchParams(page.url.searchParams);
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
      const holder = [
        ...document.querySelectorAll("details[data-anchors]"),
      ].find((node) =>
        node.getAttribute("data-anchors")?.split(" ").includes(id),
      );
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
          {#if section === "gesprek"}
            <GettingStarted />
            <div id="stem">
              <h2>Stem en geluid</h2>
              <SoundSection />
            </div>
            <div id="gesprekken"><ConversationSection /></div>
            <div id="persoonlijkheid"><BehaviorTab part="persona" /></div>
            <div id="snelle-opdrachten">
              <h2>Snelle opdrachten</h2>
              <QuickActionsEditor />
            </div>
          {:else if section === "huis"}
            <div id="home-assistant">
              <ConnectionsSection ids={["home-assistant"]} />
            </div>
            <div id="pc">
              <ConnectionsSection ids={["windows"]} />
              <DevicesSection />
            </div>
            <div id="pc-bedienen"><DesktopSection /></div>
          {:else if section === "telefoon"}
            <TelephonySection />
          {:else if section === "modellen"}
            <ModelsGuide />
          {:else if section === "zelf"}
            <div id="taken"><AutonomySection /></div>
            <div id="wat-mag">
              <h2>Wat NOVA mag gebruiken</h2>
              <AbilitiesTab
                close={() => {
                  void goto("/");
                }}
              />
            </div>
            <div id="toestemmingen"><BehaviorTab part="approvals" /></div>
            <div id="doelen"><ObjectivesSection /></div>
          {:else if section === "geheugen"}
            <MemorySection />
            <div id="documenten"><DocumentsLibrary /></div>
            <div id="backup"><BackupSection /></div>
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
