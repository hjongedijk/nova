<script lang="ts">
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
  import { setWake } from "#lib/voice/wake.ts";
  import { storage } from "#lib/util/storage.ts";

  let { element = $bindable() }: { element?: HTMLElement } = $props();

  function pick(event: MouseEvent) {
    const item = (event.target as Element).closest(".menu-item");
    if (item && !item.classList.contains("switch")) shell.menuOpen = false;
  }

  function toggleVoiceAlerts() {
    shell.voiceAlerts = !shell.voiceAlerts;
    storage.set("jarvisVoiceAlerts", shell.voiceAlerts ? "on" : "off");
  }

  function togglePanels() {
    shell.panels = !shell.panels;
    storage.set("jarvisPanels", shell.panels ? "on" : "off");
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
    class="menu-item switch"
    id="wakeToggle"
    role="menuitemcheckbox"
    aria-checked={shell.wakeEnabled}
    type="button"
    disabled={!shell.speechSupported}
    onclick={() => setWake(!shell.wakeEnabled)}
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
