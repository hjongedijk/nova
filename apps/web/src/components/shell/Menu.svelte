<script lang="ts">
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
  import { setWake } from "#lib/voice/wake.ts";
  import { storage } from "#lib/util/storage.ts";
  import {
    endFocus,
    getFocusStatus,
    startFocus,
    startWorkBlock,
    type FocusStatus,
  } from "#lib/api/shell.ts";
  import { showToast } from "#lib/stores/toasts.svelte.ts";
  import { cooking } from "#lib/cooking/session.svelte.ts";
  import { toggleHoloMenu } from "#lib/holo/store.svelte.ts";
  import { startQuickNoteCapture } from "#lib/voice/recognition.ts";

  let { element = $bindable() }: { element?: HTMLElement } = $props();
  let focus: FocusStatus | null = $state(null);
  let focusBusy = $state(false);

  $effect(() => {
    if (shell.menuOpen)
      void getFocusStatus()
        .then((value) => (focus = value))
        .catch(() => undefined);
  });

  async function changeFocus(minutes?: 25 | 60 | 120 | "pomodoro") {
    if (focusBusy) return;
    focusBusy = true;
    try {
      focus =
        minutes === "pomodoro"
          ? await startWorkBlock()
          : minutes
            ? await startFocus(minutes)
            : await endFocus();
      window.dispatchEvent(new Event("nova-focus-updated"));
    } catch {
      showToast({
        severity: "warning",
        title: "Focusmodus aanpassen mislukt",
        detail: "Probeer het opnieuw.",
      });
    } finally {
      focusBusy = false;
    }
  }

  function pick(event: MouseEvent) {
    const item = (event.target as Element).closest(".menu-item");
    if (item && !item.classList.contains("switch")) shell.menuOpen = false;
  }

  function toggleVoiceAlerts() {
    shell.voiceAlerts = !shell.voiceAlerts;
    storage.set(
      "novaVoiceAlerts",
      shell.voiceAlerts ? "on" : "off",
      "voice-alerts",
    );
  }

  function togglePanels() {
    shell.panels = !shell.panels;
    storage.set("novaPanels", shell.panels ? "on" : "off", "panels");
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="menu"
  id="menu"
  role="menu"
  hidden={!shell.menuOpen}
  bind:this={element}
  onclick={pick}
>
  <p class="menu-status">
    NOVA is <span id="systemStatus" class={shell.statusTone}
      >{shell.statusText}</span
    >
  </p>
  <button
    class="menu-item"
    id="historyOpen"
    role="menuitem"
    type="button"
    onclick={() => (dialogs.history = true)}>Gesprek</button
  >
  <button
    class="menu-item"
    id="skillsOpen"
    role="menuitem"
    type="button"
    onclick={() => {
      dialogs.settingsTab = "abilities";
      dialogs.settings = true;
    }}>Vaardigheden</button
  >
  <button
    class="menu-item"
    id="settingsOpen"
    role="menuitem"
    type="button"
    onclick={() => (dialogs.settings = true)}>Instellingen</button
  >
  <button
    class="menu-item"
    id="adminOpen"
    role="menuitem"
    type="button"
    onclick={() => (dialogs.admin = true)}>Status &amp; geheugen</button
  >
  <hr />
  <button
    class="menu-item"
    role="menuitem"
    type="button"
    onclick={() => (cooking.open = true)}>Kookmodus</button
  >
  <button
    class="menu-item"
    id="holoOpen"
    role="menuitem"
    type="button"
    onclick={toggleHoloMenu}>Visualisaties</button
  >
  <button
    class="menu-item"
    role="menuitem"
    type="button"
    onclick={startQuickNoteCapture}>Snelle notitie · F9</button
  >
  <hr />
  {#if focus?.active}
    <p class="menu-status" role="status">
      {focus.workBlock ? "Werkblok" : "Focus"} aan{focus.until
        ? ` tot ${new Date(focus.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : ""} · {focus.pending} meldingen bewaard
    </p>
    <button
      class="menu-item"
      role="menuitem"
      type="button"
      disabled={focusBusy}
      onclick={() => void changeFocus()}>Focus afronden</button
    >
  {:else}
    <button
      class="menu-item"
      role="menuitem"
      type="button"
      disabled={focusBusy}
      onclick={() => void changeFocus("pomodoro")}>Werkblok 25 minuten</button
    >
    <button
      class="menu-item"
      role="menuitem"
      type="button"
      disabled={focusBusy}
      onclick={() => void changeFocus(25)}>Focus 25 minuten</button
    >
    <button
      class="menu-item"
      role="menuitem"
      type="button"
      disabled={focusBusy}
      onclick={() => void changeFocus(60)}>Focus 1 uur</button
    >
    <button
      class="menu-item"
      role="menuitem"
      type="button"
      disabled={focusBusy}
      onclick={() => void changeFocus(120)}>Focus 2 uur</button
    >
  {/if}
  <hr />
  <button
    class="menu-item switch"
    id="wakeToggle"
    role="menuitemcheckbox"
    aria-checked={shell.wakeEnabled}
    type="button"
    disabled={!shell.speechSupported}
    onclick={() => setWake(!shell.wakeEnabled, "user")}
  >
    <span>Luisteren naar “Hey NOVA”</span><i></i>
  </button>
  <button
    class="menu-item switch"
    id="voiceToggle"
    role="menuitemcheckbox"
    aria-checked={shell.voiceAlerts}
    type="button"
    title="Laat NOVA timers en meldingen zelf uitspreken"
    onclick={toggleVoiceAlerts}
  >
    <span>Meldingen hardop</span><i></i>
  </button>
  <button
    class="menu-item switch"
    id="panelsToggle"
    role="menuitemcheckbox"
    aria-checked={shell.panels}
    type="button"
    onclick={togglePanels}
  >
    <span>Info-panelen</span><i></i>
  </button>
</div>
