<script lang="ts">
  import {
    getHelperPreferences,
    getHelperHotkeys,
    persistHelperPreferences,
  } from "#lib/api/settings.ts";
  import { onMount } from "svelte";
  import type { FeedEvent } from "@nova/contracts";
  import Orb from "#components/helper/Orb.svelte";
  import HelperUi from "#components/helper/HelperUi.svelte";
  import HelperDevices from "#components/helper/HelperDevices.svelte";
  import HelperConfirm from "#components/helper/HelperConfirm.svelte";
  import { requestHelperSize } from "#lib/api/helper.ts";
  import { answerCard, cards } from "#lib/chat/cards.svelte.ts";
  import { encodeAttachments } from "#lib/chat/attachments.ts";
  import { forgetConversation } from "#lib/api/chat.ts";
  import { showToast } from "#lib/stores/toasts.svelte.ts";
  import { getSessionId, resetSession } from "#lib/chat/session.ts";
  import "#lib/chat/ask.ts";
  import { loadPublicConfig } from "#lib/chat/index.ts";
  import { MODE_LABELS } from "#lib/entity/states.ts";
  import { ask, chat } from "#lib/stores/chat.svelte.ts";
  import {
    dashboard,
    startDashboard,
    onFeedEvents,
  } from "#lib/stores/dashboard.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
  import {
    animateHelper,
    helper,
    loadHelperPreferences,
    saveHelperPreferences,
  } from "#lib/stores/helper.svelte.ts";
  import { audioLevel } from "#lib/stores/audio-level.svelte.ts";
  import {
    createHelperCues,
    type HelperCuePlayer,
    HELPER_CUE_NAMES,
  } from "#lib/voice/helper-cues.ts";
  import { audioContext, outputVolume, applyVolume } from "#lib/voice/audio.ts";
  import { storage } from "#lib/util/storage.ts";
  import { playback } from "#lib/voice/audio.ts";
  import { pressCore } from "#lib/voice/core.ts";
  import { initRecognition, stopListening } from "#lib/voice/recognition.ts";
  import { stopSpeaking } from "#lib/voice/speaker.ts";
  import { installAudioUnlock } from "#lib/voice/unlock.ts";
  import { initWake, setWake, cancelAwait } from "#lib/voice/wake.ts";
  import "../../components/helper/helper.css";

  type View = "overview" | "chat" | "notifications" | "weather" | "lists";
  let extraViews = $state<("weather" | "lists")[]>([]);
  let extraMenu = $state(false);
  const baseTabs: { id: View; label: string }[] = [
    { id: "overview", label: "Overzicht" },
    { id: "chat", label: "Chat" },
    { id: "notifications", label: "Meldingen" },
  ];
  const tabs = $derived([
    ...baseTabs,
    ...extraViews.map((id) => ({
      id,
      label: id === "weather" ? "Weer" : "Lijsten",
    })),
  ]);
  let initialized = $state(false);
  let view: View = $state("overview");
  let expanded = $state(false);
  let hidden = $state(false);
  let autohide = $state(true);
  let contrast = $state(false);
  let settings = $state(false);
  let detail = $state("");
  let input = $state<HTMLInputElement>();
  let picker = $state<HTMLInputElement>();
  let files: File[] = $state([]);
  let fileError = $state("");
  let reading = $state(false);
  let dragging = $state(false);
  let notices: FeedEvent[] = $state([]);
  let swipe = { seq: 0, x: 0 };
  let snoozed = $state<Record<number, number>>({});
  let now = $state(Date.now());
  let cuePlayer = $state<HelperCuePlayer>();
  let preferencesNote = $state("");
  let volume = $state(50);
  let greeting = $state("");
  let wakeBeforePause = false;
  let paused = $state(false);
  let previousState = "ready";
  let thinkingTimer: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout>;
  const waiting = $derived(cards.some((card) => !card.done));
  const status = $derived(
    shell.awaiting ? "Ik luister" : MODE_LABELS[chat.uiState],
  );
  const visibleNotices = $derived(
    notices.filter((event) => !((snoozed[event.seq] ?? 0) > now)),
  );
  const busy = () =>
    chat.busy ||
    waiting ||
    shell.awaiting ||
    !!playback.current ||
    files.length > 0 ||
    !!shell.draft ||
    settings ||
    document.activeElement === input;
  function activity() {
    hidden = false;
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (busy()) activity();
      else {
        expanded = false;
        hidden = autohide;
      }
    }, 12000);
  }
  function microphone() {
    if (paused) return;
    cuePlayer?.play("listening-start");
    pressCore();
  }
  function open(next: View = view) {
    view = next;
    expanded = true;
    activity();
  }
  function close() {
    if (waiting) return;
    expanded = false;
    input?.blur();
    activity();
  }
  function select(incoming: File[]) {
    const all = [...files, ...incoming];
    fileError =
      all.length > 5
        ? "Maximaal vijf bestanden."
        : all.some((file) => file.size > 10 * 1024 * 1024)
          ? "Maximaal 10 MiB per bestand."
          : all.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024
            ? "Maximaal 20 MiB samen."
            : "";
    if (!fileError) {
      files = all;
      animateHelper("box");
      cuePlayer?.play("file");
    }
    open("chat");
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (
      paused ||
      chat.busy ||
      reading ||
      (!shell.draft.trim() && !files.length)
    )
      return;
    reading = true;
    fileError = "";
    try {
      const attachments = await encodeAttachments(files);
      const sent = await ask(shell.draft, attachments);
      if (sent) {
        shell.draft = "";
        files = [];
      }
    } catch (error) {
      fileError = (error as Error).message;
    } finally {
      reading = false;
      activity();
    }
  }
  async function clearChat() {
    if (chat.busy || waiting) return;
    stopSpeaking();
    try {
      await forgetConversation(getSessionId());
    } catch (error) {
      showToast({
        severity: "warning",
        title: "Gesprek wissen mislukt",
        detail: (error as Error).message,
      });
      return;
    }
    resetSession();
    chat.history = [];
    chat.reply = "";
    chat.you = "";
    chat.model = "";
    chat.toolResult = "";
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      settings = false;
      close();
    }
    const typing =
      event.target instanceof HTMLElement &&
      (event.target.matches("input,textarea") ||
        event.target.isContentEditable);
    const card = cards.find((card) => !card.locked);
    if (
      card &&
      !typing &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      /^[yn]$/i.test(event.key)
    ) {
      event.preventDefault();
      void answerCard(card.id, event.key.toLowerCase() === "y");
    }
  }
  $effect(() => {
    clearInterval(thinkingTimer);
    const current = chat.uiState;
    const stoppedListening =
      previousState === "listening" && current !== "listening";
    previousState = current;
    cuePlayer?.setActivity(
      audioLevel.speaking || chat.uiState === "speaking",
      chat.uiState === "listening",
    );
    if (stoppedListening && !paused) cuePlayer?.play("listening-end");
    if (
      (current === "thinking" || current === "executing") &&
      helper.cues.enabled &&
      !paused
    ) {
      const started = Date.now();
      cuePlayer?.play("thinking");
      thinkingTimer = setInterval(() => {
        if (Date.now() - started > 30000) {
          clearInterval(thinkingTimer);
          return;
        }
        cuePlayer?.play("thinking");
      }, 2500);
    }
    return () => clearInterval(thinkingTimer);
  });
  $effect(() => {
    if (chat.choices.length) animateHelper("question");
  });
  $effect(() => {
    if (/\b(dank|lief|geweldig|goed gedaan)\b/i.test(chat.you))
      animateHelper("heart");
  });
  $effect(() => {
    if (waiting) {
      expanded = true;
      hidden = false;
    }
  });
  $effect(() => {
    if (chat.busy) open("chat");
  });
  $effect(() => {
    if (chat.reply) open("chat");
  });
  $effect(() => {
    if (!initialized) return;
    void requestHelperSize(
      waiting
        ? "confirmation"
        : expanded
          ? view === "chat"
            ? "chat"
            : view
          : "compact",
      hidden,
    );
  });
  $effect(() => {
    if (!initialized) return;
    saveHelperPreferences();
    storage.set("nova.helper.view", view);
    storage.set("nova.helper.autohide", String(autohide));
    storage.set("nova.helper.contrast", String(contrast));
  });
  onMount(() => {
    document.body.classList.add("helper");
    const saved =
      new URLSearchParams(location.search).get("view") ??
      storage.get("nova.helper.view", "compact");
    expanded = saved !== "compact";
    if (["weather", "lists"].includes(saved))
      extraViews = [saved as "weather" | "lists"];
    if (tabs.some((tab) => tab.id === saved)) view = saved as View;
    autohide = storage.get("nova.helper.autohide", "true") === "true";
    contrast = storage.get("nova.helper.contrast", "false") === "true";
    let disposed = false;
    loadHelperPreferences();
    void getHelperHotkeys()
      .then((result) => {
        if (disposed) return;
        if (result.preferences?.paused) {
          paused = true;
          wakeBeforePause = shell.wakeEnabled;
          setWake(false);
          cancelAwait();
          stopListening();
          stopSpeaking();
        }
      })
      .catch(() => undefined);
    void getHelperPreferences()
      .then((prefs) => {
        if (disposed) return;
        autohide = prefs.autohide;
        contrast = prefs.contrast;
        helper.shape = prefs.shape;
        helper.cues = prefs.cues;
        if (prefs.wardrobe) helper.wardrobe = prefs.wardrobe;
        const today = new Date();
        const birthday = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        if (helper.wardrobe.seasonal && helper.wardrobe.birthday === birthday) {
          greeting = "Fijne verjaardag";
          animateHelper("heart");
        }
      })
      .catch(() => undefined);
    volume = Math.round(outputVolume() * 100);
    const hour = new Date().getHours();
    greeting =
      hour < 6
        ? "Goedenacht"
        : hour < 12
          ? "Goedemorgen"
          : hour < 18
            ? "Goedemiddag"
            : "Goedenavond";
    initialized = true;
    initRecognition();
    void loadPublicConfig();
    activity();
    const unlockCues = () => {
      if (!cuePlayer) {
        cuePlayer = createHelperCues(audioContext, () => helper.cues);
        if (!paused) cuePlayer.play("greet");
      }
    };
    window.addEventListener("pointerdown", unlockCues);
    window.addEventListener("keydown", unlockCues);
    const nativeAction = (event: Event) => {
      const action = (
        event as CustomEvent<{ action: string; paused?: boolean }>
      ).detail;
      if (action.action === "speak") {
        open("chat");
        microphone();
      }
      if (action.action === "mute") {
        stopSpeaking();
        volume = 0;
        storage.set("novaVolume", "0");
      }
      if (action.action === "settings") {
        settings = true;
        open("overview");
      }
      if (action.action === "pause") {
        paused = action.paused === true;
        if (paused) {
          wakeBeforePause = shell.wakeEnabled;
          setWake(false);
          cancelAwait();
          stopListening();
          stopSpeaking();
          cuePlayer?.stop();
        } else if (wakeBeforePause) setWake(true);
      }
    };
    window.addEventListener("nova-helper-action", nativeAction);
    const confirmationCue = (event: Event) =>
      !paused &&
      cuePlayer?.play(
        (event as CustomEvent<boolean>).detail ? "approved" : "declined",
      );
    window.addEventListener("nova-helper-confirmed", confirmationCue);
    const orbCue = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      const cue = {
        done: "done",
        error: "error",
        heart: "heart",
        box: "file",
        greet: "greet",
        sleep: "goodnight",
        wake: "wake",
        dizzy: "dizzy",
      }[name];
      if (cue && !paused)
        cuePlayer?.play(cue as (typeof HELPER_CUE_NAMES)[number]);
    };
    window.addEventListener("nova-helper-cue", orbCue);
    const nativeNotice = (event: Event) => {
      if (paused) return;
      const notice = (event as CustomEvent<FeedEvent>).detail;
      if (
        !notice ||
        typeof notice.seq !== "number" ||
        typeof notice.title !== "string"
      )
        return;
      notices = [
        notice,
        ...notices.filter((item) => item.seq !== notice.seq),
      ].slice(0, 100);
      open("notifications");
      cuePlayer?.play("notice");
    };
    window.addEventListener("nova-helper-notification", nativeNotice);
    const pending = (
      window as unknown as { __novaHelperNotifications?: FeedEvent[] }
    ).__novaHelperNotifications;
    for (const event of pending ?? [])
      nativeNotice(
        new CustomEvent("nova-helper-notification", { detail: event }),
      );
    if (pending) pending.length = 0;
    const timer = setInterval(() => {
      now = Date.now();
      const due = Object.entries(snoozed).filter(([, until]) => until <= now);
      for (const [id] of due) delete snoozed[Number(id)];
      if (due.length && !paused) {
        open("notifications");
        cuePlayer?.play("notice");
      }
    }, 1000);
    const stops = [
      installAudioUnlock(),
      initWake(),
      startDashboard(),
      onFeedEvents((events) => {
        if (paused) return;
        notices = [
          ...events,
          ...notices.filter(
            (item) => !events.some((event) => event.seq === item.seq),
          ),
        ].slice(0, 100);
        cuePlayer?.play("notice");
        open("notifications");
      }),
    ];
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      cuePlayer?.stop();
      clearInterval(thinkingTimer);
      window.removeEventListener("nova-helper-confirmed", confirmationCue);
      window.removeEventListener("pointerdown", unlockCues);
      window.removeEventListener("keydown", unlockCues);
      window.removeEventListener("nova-helper-action", nativeAction);
      window.removeEventListener("nova-helper-cue", orbCue);
      window.removeEventListener("nova-helper-notification", nativeNotice);
      clearInterval(timer);
      clearTimeout(idle);
      document.body.classList.remove("helper");
    };
  });
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>NOVA helper</title></svelte:head>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="hp"
  class:expanded
  class:contrast
  class:dragging
  class:hidden
  onpointermove={activity}
  ondragover={(event) => {
    event.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(event) => {
    event.preventDefault();
    dragging = false;
    if (!chat.busy && !reading)
      select(Array.from(event.dataTransfer?.files ?? []));
  }}
>
  <header class="hp-bar">
    <button
      class="hp-core"
      aria-label="Spreek met NOVA"
      onclick={microphone}
      onpointerdown={() => !paused && cuePlayer?.play("touch")}><Orb /></button
    >
    <button class="hp-title" onclick={() => open()}
      ><strong>NOVA</strong><span
        >{paused
          ? "Gepauzeerd"
          : chat.uiState === "ready" && !chat.history.length
            ? greeting
            : status}</span
      ></button
    >
    <meter
      class="hp-meter"
      min="0"
      max="1"
      value={audioLevel.level}
      aria-label="Stemvolume tijdens spreken"
    ></meter>
    <span
      class="hp-indicator"
      class:busy={chat.busy}
      aria-label={chat.busy ? "Bezig" : "Gereed"}
    ></span>
    <HelperUi
      class="hp-button"
      aria-label="Helperinstellingen"
      onclick={() => {
        settings = !settings;
        open("overview");
      }}>⚙</HelperUi
    >
    <HelperUi
      class="hp-button"
      aria-label={expanded ? "Inklappen" : "Uitklappen"}
      disabled={waiting}
      onclick={() => (expanded ? close() : open())}
      >{expanded ? "−" : "+"}</HelperUi
    >
  </header>
  {#if expanded}
    {#if waiting}
      <section class="hp-content hp-confirm" aria-label="Bevestiging nodig">
        {#each cards.filter((card) => !card.done) as card (card.id)}<HelperConfirm
            {card}
          />{/each}
      </section>
    {:else}
      <nav class="hp-tabs" aria-label="Helperweergaven">
        {#each tabs as tab (tab.id)}<HelperUi
            variant="tab"
            aria-current={view === tab.id ? "page" : undefined}
            onclick={() => {
              detail = "";
              settings = false;
              open(tab.id);
            }}
            >{tab.label}{#if tab.id === "notifications" && visibleNotices.length}<span
                class="hp-count">{visibleNotices.length}</span
              >{/if}</HelperUi
          >{/each}
        <HelperUi
          class="hp-more"
          aria-label="Extra weergave toevoegen"
          aria-expanded={extraMenu}
          onclick={() => (extraMenu = !extraMenu)}>+</HelperUi
        >
        {#if extraMenu}<div class="hp-extra-menu">
            {#each [{ id: "weather", label: "Weer" }, { id: "lists", label: "Lijsten" }] as extra (extra.id)}<HelperUi
                onclick={() => {
                  if (!extraViews.includes(extra.id as "weather" | "lists"))
                    extraViews.push(extra.id as "weather" | "lists");
                  extraMenu = false;
                  open(extra.id as View);
                }}>{extra.label}</HelperUi
              >{/each}
          </div>{/if}
      </nav>
      {#if settings}
        <section
          class="hp-content hp-preferences"
          aria-label="Helperinstellingen"
        >
          <label
            ><input type="checkbox" bind:checked={autohide} /> Automatisch verbergen</label
          >
          <label
            ><input type="checkbox" bind:checked={contrast} /> Hoog contrast</label
          >
          <label
            >Stemvolume <input
              type="range"
              min="0"
              max="100"
              bind:value={volume}
              oninput={() => {
                storage.set("novaVolume", String(volume / 100));
                if (playback.current) applyVolume(playback.current);
              }}
            /></label
          >
          <label
            >Orb <select bind:value={helper.shape}
              ><option value="orb">Bol</option><option value="ring">Ring</option
              ><option value="mist">Mist</option></select
            ></label
          >
          <label
            ><input type="checkbox" bind:checked={helper.cues.enabled} /> Geluidjes</label
          >
          <label
            >Kleur <select bind:value={helper.wardrobe.theme}
              ><option value="nova">NOVA</option><option value="violet"
                >Violet</option
              ><option value="gold">Goud</option></select
            ></label
          >
          <label
            ><input type="checkbox" bind:checked={helper.wardrobe.seasonal} /> Seizoensaccenten</label
          >
          <label
            >Verjaardag (optioneel, MM-DD)<HelperUi
              variant="input"
              aria-label="Verjaardag (MM-DD)"
              bind:value={helper.wardrobe.birthday}
              placeholder="MM-DD"
              maxlength={5}
            /></label
          >
          <label
            >Geluidvolume <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              bind:value={helper.cues.volume}
            /></label
          >
          <label
            >Thema <select bind:value={helper.cues.theme}
              ><option value="soft">Zacht</option><option value="playful"
                >Speels</option
              ><option value="minimal">Minimaal</option></select
            ></label
          >
          <label
            ><input type="checkbox" bind:checked={helper.cues.quiet!.enabled} /> Stille
            uren</label
          >
          <input
            aria-label="Begin stille uren"
            type="time"
            bind:value={helper.cues.quiet!.start}
          /><input
            aria-label="Einde stille uren"
            type="time"
            bind:value={helper.cues.quiet!.end}
          />
          <details>
            <summary>Geluiden kiezen</summary
            >{#each HELPER_CUE_NAMES as name (name)}<label
                ><input
                  type="checkbox"
                  checked={helper.cues.cues?.[name] !== false}
                  onchange={(event) =>
                    (helper.cues.cues = {
                      ...helper.cues.cues,
                      [name]: event.currentTarget.checked,
                    })}
                />{{
                  "listening-start": "Luisteren begint",
                  "listening-end": "Luisteren klaar",
                  thinking: "Nadenken",
                  done: "Klaar",
                  notice: "Melding",
                  error: "Fout",
                  approved: "Bevestigd",
                  declined: "Geweigerd",
                  greet: "Begroeting",
                  goodnight: "Welterusten",
                  file: "Bestand",
                  touch: "Aanraking",
                  dizzy: "Duizelig",
                  heart: "Hartje",
                  wake: "Wakker",
                }[name]}</label
              >{/each}
          </details>
          <HelperUi
            class="hp-button hp-primary"
            onclick={async () => {
              try {
                await persistHelperPreferences({
                  autohide,
                  contrast,
                  shape: helper.shape,
                  wardrobe: helper.wardrobe,
                  cues: { ...helper.cues, quiet: helper.cues.quiet! },
                });
                preferencesNote = "Helperinstellingen opgeslagen.";
              } catch (error) {
                preferencesNote = (error as Error).message;
              }
            }}>Instellingen opslaan</HelperUi
          >
          {#if preferencesNote}<p role="status">{preferencesNote}</p>{/if}
          <HelperDevices />

          <a
            class="hp-button"
            href="/?settings=devices"
            target="_blank"
            rel="noopener">Apparaat en geluid in volledige app</a
          >
        </section>
      {:else if view === "overview"}
        <section class="hp-content hp-overview" aria-label="Overzicht">
          {#each [{ name: "Server", value: dashboard.overview?.proxmox ? `${dashboard.overview.proxmox.guests.length} machines` : "Niet bereikbaar" }, { name: "Thuis", value: dashboard.overview?.home ? "Verbonden" : "Niet bereikbaar" }, { name: "Timers", value: dashboard.overview?.timers ? `${dashboard.overview.timers.length} actief` : "Onbekend" }, { name: "Agenda", value: "Nog niet gekoppeld" }] as block (block.name)}
            <button
              class="hp-block"
              onclick={() => (detail = detail === block.name ? "" : block.name)}
              ><span>{block.name}</span><strong>{block.value}</strong></button
            >
          {/each}
        </section>
        <div class="hp-integrations" aria-label="Koppelingen">
          {#each [{ name: "Proxmox", prefix: "proxmox_", ok: !!dashboard.overview?.proxmox }, { name: "Home Assistant", prefix: "ha_", ok: !!dashboard.overview?.home }, { name: "Node-RED", prefix: "nodered_", ok: dashboard.health?.nodeRed === true }, { name: "MQTT", prefix: "mqtt_", ok: dashboard.health?.mqtt === true }] as service (service.name)}<span
              class="hp-chip"
              ><i
                class:online={service.ok}
                class:busy={chat.activeTool.startsWith(service.prefix)}
                data-service={service.name}
              ></i>{service.name}<span class="hp-sr"
                >{service.ok ? "Verbonden" : "Niet verbonden"}</span
              ></span
            >{/each}
        </div>
        {#if detail}<div class="hp-detail">
            <strong>{detail}</strong><span
              >{detail === "Agenda"
                ? "Agendakoppeling volgt in fase E."
                : detail === "Server"
                  ? dashboard.overview?.proxmox?.guests
                      .map((guest) => `${guest.name} (${guest.status})`)
                      .join(" · ") || "Servergegevens niet bereikbaar."
                  : detail === "Timers"
                    ? dashboard.overview?.timers
                        ?.map((timer) => timer.label)
                        .join(" · ") || "Geen actieve timers."
                    : dashboard.overview?.home
                      ? "Home Assistant verbonden."
                      : "Thuisgegevens niet bereikbaar."}</span
            ><a href="/" target="_blank" rel="noopener">Open details ↗</a>
          </div>{/if}
      {:else if view === "weather"}
        <section class="hp-content hp-extra" aria-label="Weer">
          {#if dashboard.overview?.weather}<strong
              >{dashboard.overview.weather.name || "Het weer"} · {dashboard
                .overview.weather.temperature ?? "—"}
              {dashboard.overview.weather.temperatureUnit || "°C"}</strong
            >
            <p>{dashboard.overview.weather.condition || "Geen omschrijving"}</p>
            <span
              >Wind: {dashboard.overview.weather.windSpeed ?? "—"}
              {dashboard.overview.weather.windUnit || ""}</span
            >{:else}<p>Weergegevens zijn niet bereikbaar.</p>{/if}
        </section>
      {:else if view === "lists"}
        <section class="hp-content hp-extra" aria-label="Lijsten">
          {#each Object.entries(dashboard.overview?.lists ?? {}) as [name, items] (name)}<strong
              >{name}</strong
            >
            <p>{items.join(" · ") || "Deze lijst is leeg."}</p>{:else}<p>
              Geen lijsten beschikbaar.
            </p>{/each}
        </section>
      {:else if view === "chat"}
        <div class="hp-chat-actions">
          <span>{chat.model || "Model nog niet gemeld"}</span><HelperUi
            class="hp-button"
            disabled={chat.busy || waiting}
            onclick={clearChat}>Wis gesprek</HelperUi
          ><a class="hp-button" href="/" target="_blank" rel="noopener"
            >Volledige app ↗</a
          >
        </div>
        <section class="hp-messages" aria-label="Gesprek" aria-live="polite">
          {#each chat.history.slice(-12) as message, index (index)}<article
              class:user={message.role === "user"}
            >
              <span>{message.role === "user" ? "Jij" : "NOVA"}</span>
              <p>{message.text || "Even nadenken…"}</p>
            </article>{:else}<p class="hp-empty">
              Wat kan ik voor je doen?
            </p>{/each}
        </section>
        {#if chat.choices.length}
          <div class="hp-files" aria-label="Kies een apparaat">
            {#each chat.choices as choice (choice.entityId)}<HelperUi
                class="hp-button"
                disabled={paused || chat.busy}
                onclick={() =>
                  !paused &&
                  ask(
                    `Gebruik entity_id ${choice.entityId} voor mijn vorige vraag: ${chat.you}`,
                  )}>{choice.label}</HelperUi
              >{/each}
          </div>
        {/if}
        {#if files.length}<div class="hp-files">
            <span>Bestanden ontvangen</span
            >{#each files as file, index (file)}<HelperUi
                variant="chip"
                disabled={chat.busy || reading}
                onclick={() => (files = files.filter((_, i) => i !== index))}
                aria-label={`Verwijder ${file.name}`}>{file.name} ×</HelperUi
              >{/each}<HelperUi
              class="hp-button"
              onclick={() => (shell.draft = "Vat deze bestanden samen.")}
              >Samenvatten</HelperUi
            ><HelperUi
              class="hp-button"
              onclick={() => {
                shell.draft = "";
                input?.focus();
              }}>Vraag stellen</HelperUi
            >
          </div>{/if}
        {#if fileError}<p class="hp-error" role="alert">{fileError}</p>{/if}
        <form class="hp-form" onsubmit={submit}>
          <input
            type="file"
            multiple
            hidden
            bind:this={picker}
            onchange={(event) => {
              select(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <HelperUi
            class="hp-button"
            type="button"
            disabled={chat.busy || reading}
            onclick={() => picker?.click()}
            aria-label="Bestanden bijvoegen">+</HelperUi
          >
          <input
            class="hp-input"
            bind:this={input}
            bind:value={shell.draft}
            disabled={chat.busy || reading}
            aria-label="Bericht aan NOVA"
            placeholder="Zeg of typ iets…"
          />
          <HelperUi
            class="hp-button"
            type="button"
            hidden={!shell.speechSupported}
            onclick={microphone}
            aria-label="Microfoon">Mic</HelperUi
          >
          <HelperUi
            class="hp-button hp-primary"
            type="submit"
            disabled={chat.busy ||
              reading ||
              (!shell.draft.trim() && !files.length)}>Verstuur</HelperUi
          >
        </form>
      {:else}
        <section class="hp-notices" aria-label="Meldingen">
          {#each visibleNotices as event (event.seq)}<HelperUi
              variant="notice"
              severity={event.severity}
              onpointerdown={(pointer) =>
                (swipe = { seq: event.seq, x: pointer.clientX })}
              onpointerup={(pointer) => {
                if (
                  swipe.seq === event.seq &&
                  Math.abs(pointer.clientX - swipe.x) > 60
                )
                  notices = notices.filter((item) => item.seq !== event.seq);
              }}
            >
              <div>
                <strong>{event.title}</strong>
                <p>{event.detail}</p>
              </div>
              <HelperUi
                class="hp-button"
                onclick={() =>
                  (snoozed[event.seq] = Date.now() + 10 * 60 * 1000)}
                >Over 10 min</HelperUi
              ><HelperUi
                class="hp-button"
                aria-label={`Verwijder ${event.title}`}
                onclick={() =>
                  (notices = notices.filter((item) => item.seq !== event.seq))}
                >×</HelperUi
              >
            </HelperUi>{:else}<p class="hp-empty">
              Geen nieuwe meldingen. Ik houd het in de gaten.
            </p>{/each}
        </section>
      {/if}
      <footer class="hp-ticker" role="status">
        <i class:busy={chat.busy}></i>{chat.hint ||
          chat.toolResult ||
          (chat.busy ? "NOVA denkt na…" : "Gereed voor je volgende vraag")}
      </footer>
    {/if}
  {/if}
  {#if dragging}<div class="hp-drop">
      Laat los — ik bekijk je bestanden
    </div>{/if}
</div>
