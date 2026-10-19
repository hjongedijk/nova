<script lang="ts">
  import {
    getHelperPreferences,
    getHelperHotkeys,
    persistHelperPreferences,
  } from "#lib/api/settings.ts";
  import { onMount, tick } from "svelte";
  import { publishLocalPreferenceReceipt } from "#lib/util/local-preference-receipts.ts";
  import { SvelteSet } from "svelte/reactivity";
  import type { FeedEvent, NotificationModes } from "@nova/contracts";
  import Orb from "#components/helper/Orb.svelte";
  import Toasts from "#components/shell/Toasts.svelte";
  import ActionReceipts from "#components/shell/ActionReceipts.svelte";
  import HelperUi from "#components/helper/HelperUi.svelte";
  import HelperDevices from "#components/helper/HelperDevices.svelte";
  import HelperConfirm from "#components/helper/HelperConfirm.svelte";
  import {
    displayLabel,
    getHelperDisplays,
    requestHelperSize,
    setHelperDisplay,
  } from "#lib/api/helper.ts";
  import type { HelperDisplays } from "@nova/contracts";
  import {
    deskInvoke,
    deskLook,
    inDesk,
    type DeskInfo,
  } from "#lib/api/desk.ts";
  import { claimAlertSpeech } from "#lib/api/shell.ts";
  import { ApiError } from "#lib/api/client.ts";
  import { friendlyApiError } from "#lib/api/error-copy.ts";
  import {
    answerCard,
    cards,
    confirmationShortcutApproval,
  } from "#lib/chat/cards.svelte.ts";
  import { encodeAttachments } from "#lib/chat/attachments.ts";
  import { forgetConversation } from "#lib/api/chat.ts";
  import { showToast } from "#lib/stores/toasts.svelte.ts";
  import {
    getSessionId,
    resetSession,
    getConversationLanguage,
    setConversationLanguage,
  } from "#lib/chat/session.ts";
  import "#lib/chat/ask.ts";
  import { loadPublicConfig } from "#lib/chat/index.ts";
  import { MODE_LABELS, MOOD_LABELS } from "#lib/entity/states.ts";
  import { ask, chat } from "#lib/stores/chat.svelte.ts";
  import {
    dashboard,
    startDashboard,
    pollOverview,
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
    lightSync,
    setLightSync,
    startLightSync,
  } from "#lib/stores/light-sync.svelte.ts";
  async function recordHelperPreference(event: Event): Promise<void> {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest("[data-helper-live]")) return;
    await tick();
    const personalityStored = saveHelperPreferences();
    const flags = [
      ["nova.helper.autohide", String(autohide)],
      ["nova.helper.contrast", String(contrast)],
    ] as const;
    for (const [key, value] of flags) storage.set(key, value);
    publishLocalPreferenceReceipt(
      "helper-preferences",
      personalityStored &&
        flags.every(([key, value]) => storage.matches(key, value)),
    );
    try {
      await persistHelperPreferences({
        autohide,
        contrast,
        shape: helper.shape,
        notifications: helper.notifications,
        rituals: helper.rituals,
        wardrobe: helper.wardrobe,
        cues: { ...helper.cues, quiet: helper.cues.quiet! },
      });
      preferencesNote = "Helperinstellingen gesynchroniseerd.";
    } catch {
      preferencesNote =
        "Alleen lokaal opgeslagen. Probeer opnieuw op te slaan.";
    }
  }
  const MODEL_ROLE_LABELS: Record<string, string> = {
    conversation: "Gesprek",
    code: "Code",
    planning: "Denken en plannen",
    summary: "Samenvatten",
    vision: "Beeld",
    embedding: "Inbedden",
  };
  import {
    createHelperCues,
    type HelperCuePlayer,
    HELPER_CUE_NAMES,
    canSpeakFeedEvent,
    feedSpeechText,
    shouldOpenHelperForFeedEvent,
  } from "#lib/voice/helper-cues.ts";
  import { audioContext, outputVolume, applyVolume } from "#lib/voice/audio.ts";
  import { storage } from "#lib/util/storage.ts";
  import { playback } from "#lib/voice/audio.ts";
  import { pressCore } from "#lib/voice/core.ts";
  import { initRecognition, stopListening } from "#lib/voice/recognition.ts";
  import { speak, stopSpeaking } from "#lib/voice/speaker.ts";
  import { installAudioUnlock } from "#lib/voice/unlock.ts";
  import { initWake, setWake, cancelAwait } from "#lib/voice/wake.ts";
  import {
    readHelperSnoozes,
    writeHelperSnoozes,
    type SavedHelperSnooze,
  } from "#lib/voice/helper-snoozes.ts";
  import "../../components/helper/helper.css";

  let responseLanguage = $state(getConversationLanguage());
  function changeConversationLanguage(value: "nl" | "en") {
    responseLanguage = setConversationLanguage(value);
  }

  const notificationKinds: { key: keyof NotificationModes; label: string }[] = [
    { key: "info", label: "Informatie" },
    { key: "briefing", label: "Dagoverzicht" },
    { key: "warning", label: "Waarschuwing" },
    { key: "critical", label: "Kritiek" },
    { key: "timer", label: "Timer" },
  ];

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
  let fullscreen = $state(false);
  /** The look inside NOVA Desk (or ?desk=1): transparent page, the panel is the rounded shape. */
  let desk = $state(false);
  let panel = $state<HTMLDivElement>();
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
  let savedSnoozes: SavedHelperSnooze[] = [];
  const snoozeStorageKey = "nova.helper.snoozes.v1";
  function persistSnoozes() {
    storage.set(snoozeStorageKey, writeHelperSnoozes(savedSnoozes));
  }
  function snoozeNotice(event: FeedEvent) {
    const until = Date.now() + 10 * 60_000;
    snoozed[event.seq] = until;
    savedSnoozes = [
      ...savedSnoozes.filter((item) => item.event.seq !== event.seq),
      { event, until },
    ].slice(-20);
    persistSnoozes();
  }
  function dismissNotice(seq: number) {
    notices = notices.filter((item) => item.seq !== seq);
    delete snoozed[seq];
    savedSnoozes = savedSnoozes.filter((item) => item.event.seq !== seq);
    persistSnoozes();
  }
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
  function safeErrorCopy(error: unknown): string {
    return error instanceof ApiError ? error.message : friendlyApiError(error);
  }
  const waiting = $derived(cards.some((card) => !card.done));
  const status = $derived(
    shell.awaiting ? "Ik luister" : MODE_LABELS[chat.uiState],
  );
  /** idle, listening, thinking or speaking: drives the colour and motion of the panel. */
  const orbState = $derived(
    shell.awaiting
      ? "listening"
      : chat.uiState === "ready"
        ? "idle"
        : chat.uiState === "executing"
          ? "thinking"
          : chat.uiState,
  );
  const nextAppointment = $derived(dashboard.overview?.nextAppointment ?? null);
  function appointmentStart(): string {
    if (!nextAppointment) return "";
    const date = nextAppointment.allDay
      ? new Date(`${nextAppointment.start.slice(0, 10)}T12:00:00`)
      : new Date(nextAppointment.start);
    return nextAppointment.allDay
      ? date.toLocaleDateString("nl-NL", {
          weekday: "short",
          day: "numeric",
          month: "short",
        })
      : date.toLocaleString("nl-NL", {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: nextAppointment.timeZone ?? undefined,
        });
  }
  const visibleNotices = $derived(
    notices.filter((event) => !((snoozed[event.seq] ?? 0) > now)),
  );
  type BlockState = "ok" | "loading" | "error" | "off";
  type Block = {
    name: string;
    value: string;
    detail: string;
    state: BlockState;
    available: boolean;
  };
  /** Not loaded yet: show "Laden…". Only a failed request says "Niet bereikbaar". */
  const overviewLoading = $derived(
    !dashboard.overview && !dashboard.overviewFailed,
  );
  const overviewDown = $derived(
    !dashboard.overview && dashboard.overviewFailed,
  );
  function block(
    name: string,
    state: BlockState,
    value: string,
    detail: string,
  ): Block {
    return { name, state, value, detail, available: state === "ok" };
  }
  function unreachable(name: string, off: boolean, what: string): Block {
    if (overviewLoading) return block(name, "loading", "Laden…", "");
    if (off)
      return block(
        name,
        "off",
        "Niet gekoppeld",
        `${what} is niet gekoppeld. Dat doe je in de volledige app onder Instellingen.`,
      );
    return block(
      name,
      "error",
      "Niet bereikbaar",
      `${what} geeft nu geen antwoord. NOVA probeert het zo opnieuw.`,
    );
  }
  const overviewBlocks = $derived.by((): Block[] => {
    const o = dashboard.overview;
    const services = dashboard.health?.services;
    const server = o?.proxmox
      ? block(
          "Server",
          "ok",
          `${o.proxmox.guests.length} machines`,
          o.proxmox.guests
            .map((guest) => `${guest.name} (${guest.status})`)
            .join(" · ") || "Geen machines gevonden.",
        )
      : unreachable(
          "Server",
          !overviewDown &&
            !!dashboard.health &&
            !dashboard.health.state?.proxmox,
          "De server (Proxmox)",
        );
    const home = o?.home
      ? block("Thuis", "ok", "Verbonden", "Home Assistant is verbonden.")
      : unreachable(
          "Thuis",
          !overviewDown && services?.homeAssistant?.configured === false,
          "Home Assistant",
        );
    const timers = o?.timers
      ? block(
          "Timers",
          "ok",
          `${o.timers.length} actief`,
          o.timers.map((timer) => timer.label).join(" · ") ||
            "Geen actieve timers.",
        )
      : overviewLoading
        ? block("Timers", "loading", "Laden…", "")
        : block(
            "Timers",
            "error",
            "Onbekend",
            "De timers konden niet worden opgehaald.",
          );
    const status = o?.calendarStatus;
    const agenda = nextAppointment
      ? block(
          "Agenda",
          "ok",
          appointmentStart(),
          `${nextAppointment.summary} · ${appointmentStart()}`,
        )
      : overviewLoading
        ? block("Agenda", "loading", "Laden…", "")
        : status === "ready"
          ? block(
              "Agenda",
              "ok",
              "Geen komende afspraak",
              "Er staan geen komende afspraken in de gekoppelde agenda.",
            )
          : status === "not-configured"
            ? block(
                "Agenda",
                "off",
                "Niet gekoppeld",
                "Koppel een agenda via de instellingen om afspraken te tonen.",
              )
            : status === "protected"
              ? block(
                  "Agenda",
                  "off",
                  "Verborgen",
                  "Je afspraken staan hier pas als de beveiliging van NOVA is ingesteld. Dat doe je in de volledige app onder Instellingen.",
                )
              : block(
                  "Agenda",
                  "error",
                  "Niet bereikbaar",
                  "De gekoppelde agenda kon niet worden opgehaald.",
                );
    return [server, home, timers, agenda];
  });

  /* The screen menu: which display the helper appears on. */
  let screens = $state<HelperDisplays | null>(null);
  let screenMenu = $state(false);
  let screenNote = $state("");
  async function loadScreens(): Promise<void> {
    try {
      if (inDesk()) {
        // NOVA Desk knows the displays itself; no round trip through the server and the agent.
        const info = await deskInvoke<DeskInfo>("desk_info");
        screens = {
          available: info.displays.length > 1,
          mode: "helper",
          display: info.display,
          displays: info.displays,
        };
      } else screens = await getHelperDisplays();
    } catch {
      screens = null;
    }
  }
  const currentScreen = $derived.by(() => {
    const list = screens?.displays ?? [];
    return (
      list.find((screen) => screen.index === screens?.display) ??
      list.find((screen) => screen.primary)
    );
  });
  async function chooseScreen(index: number): Promise<void> {
    screenMenu = false;
    screenNote = "De helper verhuist…";
    try {
      if (inDesk()) {
        await deskInvoke("desk_set_display", { index });
        // Also tell the server (best effort), so the display choice in NOVA's settings stays the same.
        void setHelperDisplay(index).catch(() => undefined);
        await loadScreens();
        screenNote = "";
        return;
      }
      const result = await setHelperDisplay(index);
      screens = result;
      screenNote = result.applied
        ? ""
        : "Keuze opgeslagen, maar de pc nam hem nog niet over.";
    } catch {
      screenNote = "Verhuizen is niet gelukt. Controleer de verbinding.";
    }
  }
  const busy = () =>
    fullscreen ||
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
    if (document.fullscreenElement) void document.exitFullscreen();
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
      fileError = safeErrorCopy(error);
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
        detail: safeErrorCopy(error),
      });
      return;
    }
    resetSession();
    responseLanguage = getConversationLanguage();
    chat.history = [];
    chat.actionReceipts.length = 0;
    chat.reply = "";
    chat.you = "";
    chat.model = "";
    chat.modelRole = "";
    chat.mood = "neutral";
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
      const approval = confirmationShortcutApproval(card, event.key);
      if (approval !== null) void answerCard(card.id, approval);
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
    if (!initialized || fullscreen) return;
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
    desk = deskLook();
    if (desk) document.documentElement.classList.add("desk");
    savedSnoozes = readHelperSnoozes(storage.get(snoozeStorageKey, "[]"));
    notices = [...savedSnoozes.map((item) => item.event), ...notices].slice(
      0,
      100,
    );
    snoozed = Object.fromEntries(
      savedSnoozes
        .filter((item) => item.until > Date.now())
        .map((item) => [item.event.seq, item.until]),
    );
    const restoredDue = savedSnoozes.some(
      (item) =>
        item.until <= Date.now() &&
        shouldOpenHelperForFeedEvent(item.event, helper.notifications),
    );
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
    void loadScreens();
    void getHelperHotkeys()
      .then((result) => {
        if (disposed) return;
        if (result.preferences?.paused) {
          paused = true;
          shell.wakeSuspended = true;
          wakeBeforePause = shell.wakeEnabled;
          setWake(false);
          cancelAwait();
          stopListening();
          stopSpeaking();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed && restoredDue && !paused) open("notifications");
      });
    void getHelperPreferences()
      .then((prefs) => {
        if (disposed) return;
        autohide = prefs.autohide;
        contrast = prefs.contrast;
        helper.shape = prefs.shape;
        if (prefs.notifications)
          helper.notifications = {
            ...helper.notifications,
            ...prefs.notifications,
          };
        if (prefs.rituals) helper.rituals = prefs.rituals;
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
        storage.set("novaVolume", "0", "volume");
      }
      if (action.action === "settings") {
        settings = true;
        open("overview");
      }
      if (action.action === "pause") {
        paused = action.paused === true;
        shell.wakeSuspended = paused;
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
    const syncedPreferences = (event: Event) => {
      const prefs = (
        event as CustomEvent<{ autohide: boolean; contrast: boolean }>
      ).detail;
      autohide = prefs.autohide;
      contrast = prefs.contrast;
    };
    const syncedVolume = () => {
      volume = Math.round(outputVolume() * 100);
    };
    window.addEventListener(
      "nova-helper-preferences-synced",
      syncedPreferences,
    );
    window.addEventListener("nova-preferences-synced", syncedVolume);
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
    const welcomed = new SvelteSet<number>();
    const waveForWelcome = (notice: FeedEvent) => {
      if (notice.key !== "welcome-home" || welcomed.has(notice.seq)) return;
      welcomed.add(notice.seq);
      if (welcomed.size > 50) welcomed.delete(welcomed.values().next().value!);
      animateHelper("wave");
    };
    const nativeNotice = (event: Event) => {
      if (paused) return;
      const notice = (event as CustomEvent<FeedEvent>).detail;
      if (
        !notice ||
        typeof notice.seq !== "number" ||
        typeof notice.title !== "string"
      )
        return;
      waveForWelcome(notice);
      notices = [
        notice,
        ...notices.filter((item) => item.seq !== notice.seq),
      ].slice(0, 100);
      if (shouldOpenHelperForFeedEvent(notice, helper.notifications)) {
        open("notifications");
        cuePlayer?.play("notice");
      }
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
      if (
        due.some(([id]) =>
          notices.some(
            (notice) =>
              notice.seq === Number(id) &&
              shouldOpenHelperForFeedEvent(notice, helper.notifications),
          ),
        ) &&
        !paused
      ) {
        open("notifications");
        cuePlayer?.play("notice");
      }
    }, 1000);
    const stops = [
      installAudioUnlock(),
      initWake(),
      startLightSync(),
      startDashboard(),
      onFeedEvents((events) => {
        if (paused) return;
        for (const event of events) waveForWelcome(event);
        notices = [
          ...events,
          ...notices.filter(
            (item) => !events.some((event) => event.seq === item.seq),
          ),
        ].slice(0, 100);
        if (
          events.some((event) =>
            shouldOpenHelperForFeedEvent(event, helper.notifications),
          )
        ) {
          cuePlayer?.play("notice");
          open("notifications");
        }
        if (
          !canSpeakFeedEvent(
            paused,
            chat.busy || chat.uiState === "speaking" || audioLevel.speaking,
            helper.cues,
          )
        )
          return;
        void (async () => {
          const claimed: FeedEvent[] = [];
          for (const event of events)
            if (event.speakAllowed && (await claimAlertSpeech(event.seq)))
              claimed.push(event);
          const spoken = feedSpeechText(claimed);
          if (
            spoken &&
            canSpeakFeedEvent(
              paused,
              chat.busy || chat.uiState === "speaking" || audioLevel.speaking,
              helper.cues,
            )
          )
            void speak(spoken);
        })().catch(() => undefined);
      }),
    ];
    return () => {
      disposed = true;
      shell.wakeSuspended = false;
      window.removeEventListener(
        "nova-helper-preferences-synced",
        syncedPreferences,
      );
      window.removeEventListener("nova-preferences-synced", syncedVolume);
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
<svelte:document
  onfullscreenchange={() => (fullscreen = !!document.fullscreenElement)}
/>
<svelte:head><title>NOVA helper</title></svelte:head>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="hp"
  bind:this={panel}
  data-view={waiting ? "confirmation" : view}
  data-state={paused ? "idle" : orbState}
  style:--level={audioLevel.level}
  class:expanded
  class:desk
  class:deskfull={desk && fullscreen}
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
      title="Spreek met NOVA"
      onclick={microphone}
      onpointerdown={() => !paused && cuePlayer?.play("touch")}><Orb /></button
    >
    <button class="hp-title" onclick={() => open()} title="NOVA openen"
      ><strong>NOVA</strong><span class="hp-pill" class:busy={chat.busy}
        ><i></i>{paused
          ? "Gepauzeerd"
          : chat.uiState === "ready" && !chat.history.length
            ? greeting
            : status}</span
      ></button
    >
    {#if expanded && !waiting}
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
          title="Extra weergave toevoegen"
          aria-expanded={extraMenu}
          onclick={() => (extraMenu = !extraMenu)}>+</HelperUi
        >
        {#if extraMenu}<div class="hp-menu hp-extra-menu">
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
    {/if}
    <meter
      class="hp-sr"
      min="0"
      max="1"
      value={audioLevel.level}
      aria-label="Stemvolume tijdens spreken"
    ></meter>
    <div class="hp-tools" role="toolbar" aria-label="Helper">
      {#if screens?.available}
        <div class="hp-screen">
          <HelperUi
            class="hp-icon"
            aria-label="Scherm kiezen"
            title={currentScreen
              ? `Scherm: ${displayLabel(currentScreen)}`
              : "Scherm kiezen"}
            aria-expanded={screenMenu}
            aria-haspopup="menu"
            onclick={() => {
              screenMenu = !screenMenu;
              if (screenMenu) void loadScreens();
            }}
            ><svg viewBox="0 0 20 20" aria-hidden="true"
              ><rect x="2.5" y="4" width="15" height="10" rx="1.5" /><path
                d="M7 17h6M10 14v3"
              /></svg
            ><span class="hp-icon-label">Scherm</span></HelperUi
          >
          {#if screenMenu}
            <div
              class="hp-menu hp-screen-menu"
              role="menu"
              aria-label="Scherm voor de helper"
            >
              <p>Scherm voor de helper</p>
              {#each screens.displays ?? [] as screen (screen.index)}
                <HelperUi
                  role="menuitemradio"
                  aria-checked={currentScreen?.index === screen.index}
                  class={currentScreen?.index === screen.index ? "current" : ""}
                  onclick={() => chooseScreen(screen.index)}
                  ><span aria-hidden="true"
                    >{currentScreen?.index === screen.index ? "✓" : ""}</span
                  >{displayLabel(screen)}</HelperUi
                >
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <HelperUi
        class="hp-icon"
        aria-label="Helperinstellingen"
        title="Instellingen"
        aria-pressed={settings}
        onclick={() => {
          settings = !settings;
          open("overview");
        }}
        ><svg viewBox="0 0 20 20" aria-hidden="true"
          ><circle cx="10" cy="10" r="2.6" /><path
            d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"
          /></svg
        ></HelperUi
      >
      {#if expanded}
        <HelperUi
          class="hp-icon"
          aria-label={fullscreen
            ? "Volledig scherm verlaten"
            : "Volledig scherm"}
          title={fullscreen ? "Volledig scherm verlaten" : "Volledig scherm"}
          onclick={() => {
            if (inDesk()) {
              const next = !fullscreen;
              void deskInvoke("desk_set_fullscreen", { on: next })
                .then(() => (fullscreen = next))
                .catch(() => undefined);
              return;
            }
            if (document.fullscreenElement) void document.exitFullscreen();
            else void panel?.requestFullscreen().catch(() => undefined);
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" /></svg
          ></HelperUi
        >
        <HelperUi
          class="hp-icon"
          aria-label="Helper verbergen"
          title="Verbergen (komt terug bij een melding)"
          disabled={waiting}
          onclick={() => {
            // In NOVA Desk the window itself goes away (the tray brings it back); elsewhere the panel folds to a strip.
            if (inDesk()) {
              void deskInvoke("desk_hide_helper").catch(() => undefined);
              return;
            }
            close();
            hidden = true;
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M5 5l10 10M15 5L5 15" /></svg
          ></HelperUi
        >
      {/if}
      <HelperUi
        class="hp-icon"
        aria-label={expanded ? "Inklappen" : "Uitklappen"}
        title={expanded ? "Inklappen" : "Uitklappen"}
        disabled={waiting}
        onclick={() => (expanded ? close() : open())}
        ><svg viewBox="0 0 20 20" aria-hidden="true"
          ><path d={expanded ? "M4 7l6 6 6-6" : "M4 13l6-6 6 6"} /></svg
        ></HelperUi
      >
    </div>
  </header>
  {#if screenNote}<p class="hp-screen-note" role="status">{screenNote}</p>{/if}
  {#if expanded}
    {#if waiting}
      <section class="hp-content hp-confirm" aria-label="Bevestiging nodig">
        {#each cards.filter((card) => !card.done) as card (card.id)}<HelperConfirm
            {card}
          />{/each}
      </section>
    {:else}
      {#if settings}
        <section
          class="hp-content hp-preferences"
          aria-label="Helperinstellingen"
          onchange={recordHelperPreference}
        >
          <label
            ><input type="checkbox" data-helper-live bind:checked={autohide} /> Automatisch
            verbergen</label
          >
          <label
            ><input type="checkbox" data-helper-live bind:checked={contrast} /> Hoog
            contrast</label
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
              onchange={() =>
                storage.set("novaVolume", String(volume / 100), "volume")}
            /></label
          >
          <label
            >Orb <select data-helper-live bind:value={helper.shape}
              ><option value="orb">Bol</option><option value="ring">Ring</option
              ><option value="mist">Mist</option></select
            ></label
          >
          <label
            ><input
              type="checkbox"
              data-helper-live
              bind:checked={helper.cues.enabled}
            /> Geluidjes</label
          >
          <label
            >Kleur <select data-helper-live bind:value={helper.wardrobe.theme}
              ><option value="nova">NOVA</option><option value="violet"
                >Violet</option
              ><option value="gold">Goud</option></select
            ></label
          >
          <label
            ><input
              type="checkbox"
              checked={lightSync.enabled}
              onchange={(event) => setLightSync(event.currentTarget.checked)}
            /> Orbkleur volgt kamerlampen</label
          >
          <label
            >Kamer
            <select
              aria-label="Kamer voor orbkleur"
              value={lightSync.areaId}
              disabled={!lightSync.enabled}
              onchange={(event) =>
                setLightSync(true, event.currentTarget.value)}
            >
              <option value="">Kies een kamer</option>
              {#each lightSync.areas as area (area.areaId)}
                <option value={area.areaId}>{area.areaName}</option>
              {/each}
            </select></label
          >
          {#if lightSync.enabled && lightSync.unavailable}
            <p class="hint">
              Home Assistant is nu niet bereikbaar. De gewone orbkleur blijft
              zichtbaar.
            </p>
          {:else if lightSync.enabled && lightSync.areas.length === 0}
            <p class="hint">
              Geen ingeschakelde kleurenlamp in een toegestane kamer gevonden.
            </p>
          {/if}
          <label
            ><input
              type="checkbox"
              data-helper-live
              bind:checked={helper.wardrobe.seasonal}
            /> Seizoensaccenten</label
          >
          <label data-helper-live
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
              data-helper-live
              bind:value={helper.cues.volume}
            /></label
          >
          <label
            >Thema <select data-helper-live bind:value={helper.cues.theme}
              ><option value="soft">Zacht</option><option value="playful"
                >Speels</option
              ><option value="minimal">Minimaal</option></select
            ></label
          >
          <label
            ><input
              type="checkbox"
              data-helper-live
              bind:checked={helper.cues.quiet!.enabled}
            /> Stille uren</label
          >
          <input
            aria-label="Begin stille uren"
            type="time"
            data-helper-live
            bind:value={helper.cues.quiet!.start}
          /><input
            aria-label="Einde stille uren"
            type="time"
            data-helper-live
            bind:value={helper.cues.quiet!.end}
          />
          <fieldset class="hp-notification-preferences" data-helper-live>
            <legend>Meldingen</legend>
            {#each notificationKinds as notice (notice.key)}
              <label
                >{notice.label}
                <select bind:value={helper.notifications[notice.key]}>
                  <option value="screen">Alleen scherm</option>
                  <option value="helper">Helper met geluidje</option>
                  <option value="speak">Uitspreken</option>
                </select>
              </label>
            {/each}
          </fieldset>
          <fieldset class="hp-notification-preferences">
            <legend>Rituelen (standaard uit)</legend>
            <label
              ><input
                type="checkbox"
                bind:checked={helper.rituals.morning.enabled}
              /> Goedemorgen</label
            >
            <label
              >Om <input
                aria-label="Goedemorgen om"
                type="time"
                bind:value={helper.rituals.morning.time}
              /></label
            >
            <label
              ><input
                type="checkbox"
                bind:checked={helper.rituals.evening.enabled}
              /> Welterusten</label
            >
            <label
              >Om <input
                aria-label="Welterusten om"
                type="time"
                bind:value={helper.rituals.evening.time}
              /></label
            >
            <label
              ><input
                type="checkbox"
                bind:checked={helper.rituals.checkIn.enabled}
              /> Check-in na stilte</label
            >
            <label
              >Na
              <select bind:value={helper.rituals.checkIn.afterHours}>
                <option value={3}>3 uur</option><option value={4}>4 uur</option
                ><option value={6}>6 uur</option>
              </select>
            </label>
            <label
              ><input
                type="checkbox"
                bind:checked={helper.rituals.weeklyOverview.enabled}
              /> Weekoverzicht op zondag</label
            >
            <label
              >Om <input
                aria-label="Weekoverzicht op zondag om"
                type="time"
                bind:value={helper.rituals.weeklyOverview.time}
              /></label
            >
            <label
              ><input
                type="checkbox"
                bind:checked={helper.rituals.dailyHighlight.enabled}
              /> Dagelijks hoogtepunt</label
            >
            <label
              >Om <input
                aria-label="Dagelijks hoogtepunt om"
                type="time"
                bind:value={helper.rituals.dailyHighlight.time}
              /></label
            >
            <label
              ><input
                type="checkbox"
                bind:checked={helper.rituals.smallSurprises.enabled}
              /> Kleine verrassingen bij een gelegenheid</label
            >
            <label
              ><input
                type="checkbox"
                bind:checked={helper.rituals.welcomeHome.enabled}
              /> Welkom thuis na Home Assistant-thuiskomst</label
            >
            <label
              ><input
                type="checkbox"
                bind:checked={helper.rituals.calendarReminders.enabled}
              /> Agenda-herinneringen</label
            >
            <label
              >Vooraf
              <select
                bind:value={helper.rituals.calendarReminders.minutesBefore}
              >
                <option value={5}>5 minuten</option>
                <option value={15}>15 minuten</option>
                <option value={30}>30 minuten</option>
              </select>
            </label>
            <p class="hint">
              Rituelen komen als gewone melding en volgen je meldingskeuze,
              stille uren en aanwezigheid. Agenda-herinneringen staan standaard
              uit en werken als je een kalender hebt gekoppeld. Het
              weekoverzicht gebruikt alleen de gratis gecontroleerde
              samenvattingsroute.
            </p>
          </fieldset>
          <details data-helper-live>
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
                const result = await persistHelperPreferences({
                  autohide,
                  contrast,
                  shape: helper.shape,
                  notifications: helper.notifications,
                  rituals: helper.rituals,
                  wardrobe: helper.wardrobe,
                  cues: { ...helper.cues, quiet: helper.cues.quiet! },
                });
                preferencesNote =
                  result.auditWarning ?? "Helperinstellingen opgeslagen.";
              } catch (error) {
                preferencesNote =
                  error instanceof ApiError
                    ? error.message
                    : "Helperinstellingen zijn niet opgeslagen. Controleer de verbinding en probeer opnieuw.";
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
        <section class="hp-content hp-overview-layout" aria-label="Overzicht">
          <div class="hp-overview">
            {#each overviewBlocks as block (block.name)}
              <button
                class="hp-block"
                data-state={block.state}
                class:available={block.available}
                aria-expanded={detail === block.name}
                onclick={() =>
                  (detail = detail === block.name ? "" : block.name)}
                ><span class="hp-block-name"><i></i>{block.name}</span><strong
                  class:skeleton={block.state === "loading"}
                  >{block.value}</strong
                >{#if block.state !== "loading"}<small title={block.detail}
                    >{block.detail}</small
                  >{/if}</button
              >
            {/each}
          </div>
          {#if overviewDown}
            <div class="hp-retry" role="status">
              <span>Het overzicht kon niet worden geladen.</span>
              <HelperUi class="hp-button" onclick={() => pollOverview()}
                >Opnieuw proberen</HelperUi
              >
            </div>
          {/if}
        </section>
        {#if detail}<div class="hp-detail">
            <strong>{detail}</strong><span
              >{overviewBlocks.find((block) => block.name === detail)
                ?.detail}</span
            >
            <a href="/" target="_blank" rel="noopener">Open details ↗</a>
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
          <select
            class="hp-button"
            aria-label="Gesprekstaal"
            value={responseLanguage}
            onchange={(event) =>
              changeConversationLanguage(
                event.currentTarget.value === "en" ? "en" : "nl",
              )}
          >
            <option value="nl">Nederlands</option>
            <option value="en">English</option>
          </select>
          <span
            >{chat.model
              ? `${MODEL_ROLE_LABELS[chat.modelRole] ?? "Model"} · ${chat.model}`
              : "Model nog niet gemeld"}</span
          >
          {#if chat.reply && chat.mood !== "neutral"}<span
              class="hp-mood"
              aria-label="Toon van het antwoord">{MOOD_LABELS[chat.mood]}</span
            >{/if}
          <HelperUi
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
            </article>{:else}{#if !chat.actionReceipts.length}<p
                class="hp-empty"
              >
                Wat kan ik voor je doen?
              </p>{/if}{/each}
          <Toasts inline />
          <ActionReceipts separateWindow />
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
                  dismissNotice(event.seq);
              }}
            >
              <div>
                <strong>{event.title}</strong>
                <p>{event.detail}</p>
              </div>
              <HelperUi class="hp-button" onclick={() => snoozeNotice(event)}
                >Over 10 min</HelperUi
              ><HelperUi
                class="hp-button"
                aria-label={`Verwijder ${event.title}`}
                onclick={() => dismissNotice(event.seq)}>×</HelperUi
              >
            </HelperUi>{:else}<p class="hp-empty">
              Geen nieuwe meldingen. Ik houd het in de gaten.
            </p>{/each}
        </section>
      {/if}
      <div class="hp-foot">
        <footer class="hp-ticker" role="status">
          <i class:busy={chat.busy}></i>{chat.hint ||
            chat.toolResult ||
            (chat.busy ? "NOVA denkt na…" : "Gereed voor je volgende vraag")}
        </footer>
        {#if view === "overview" && !settings}
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
        {/if}
      </div>
    {/if}
  {/if}
  {#if dragging}<div class="hp-drop">
      Laat los — ik bekijk je bestanden
    </div>{/if}
</div>
