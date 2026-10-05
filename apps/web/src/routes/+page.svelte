<script lang="ts">
  import { onMount } from "svelte";
  import AdminDialog from "#components/admin/AdminDialog.svelte";
  import Column from "#components/hud/Column.svelte";
  import Composer from "#components/shell/Composer.svelte";
  import Entity from "#components/shell/Entity.svelte";
  import Header from "#components/shell/Header.svelte";
  import HistoryDrawer from "#components/shell/HistoryDrawer.svelte";
  import Stage from "#components/shell/Stage.svelte";
  import Toasts from "#components/shell/Toasts.svelte";
  import SettingsDialog from "#components/settings/SettingsDialog.svelte";
  import {
    loadPublicConfig,
    startAlerts,
    startStatus,
  } from "#lib/chat/index.ts";
  import "#lib/chat/ask.ts";
  import { glowColor } from "#lib/entity/states.ts";
  import { applyWallpaperMode } from "#lib/modes/wallpaper.ts";
  import { startPwa } from "#lib/modes/pwa.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { chrome } from "#lib/stores/chrome.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
  import { storage } from "#lib/util/storage.ts";
  import { initRecognition } from "#lib/voice/recognition.ts";
  import { installAudioUnlock } from "#lib/voice/unlock.ts";
  import { initWake } from "#lib/voice/wake.ts";

  // What the CSS needs on <body>: the entity's state and colour, the controls, the info panels.
  $effect(() => {
    document.body.dataset.state = chat.uiState;
    document.body.style.setProperty("--glow", glowColor(chat.uiState));
  });
  $effect(() => {
    document.body.classList.toggle("chrome", chrome.shown);
  });
  $effect(() => {
    document.body.classList.toggle("no-panels", !shell.panels);
  });

  onMount(() => {
    shell.voiceAlerts = storage.get("jarvisVoiceAlerts", "on") !== "off";
    shell.panels = storage.get("jarvisPanels", "on") !== "off";
    initRecognition();
    const stops = [
      applyWallpaperMode(),
      installAudioUnlock(),
      startPwa(),
      initWake(),
      startStatus(),
      startAlerts(),
    ];
    void loadPublicConfig();
    return () => stops.forEach((stop) => stop());
  });
</script>

<Entity />
<Column side="left" />
<Column side="right" />
<div class="shell">
  <Header />
  <Stage />
  <Composer />
</div>
<Toasts />
<HistoryDrawer />
<SettingsDialog />
<AdminDialog />
