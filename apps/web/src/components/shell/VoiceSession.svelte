<script lang="ts">
  import {
    chooseDevice,
    conversation,
    startConversation,
    stopConversation,
  } from "#lib/voice/conversation-session.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";

  const active = $derived(conversation.phase !== "off");
  const label = $derived(
    conversation.phase === "thinking"
      ? "Denkt na"
      : conversation.phase === "speaking"
        ? "Praat"
        : "Luistert",
  );

  function toggle(): void {
    if (active) stopConversation();
    else void startConversation();
  }
</script>

<button
  id="conversationButton"
  class="icon"
  class:on={active}
  type="button"
  aria-label={active ? "Gesprek stoppen" : "Gesprek starten"}
  aria-pressed={active}
  title={active
    ? "Stop het gesprek"
    : "Start een gesprek: NOVA blijft luisteren tot je ‘stop’ zegt"}
  hidden={!shell.speechSupported}
  onclick={toggle}
>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 12h2M8 8v8M12 5v14M16 8v8M20 12h-2" />
  </svg>
</button>

{#if active}
  <div class="voice-session" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <span>{label}</span>
    {#if conversation.devices.length > 1}
      <select
        aria-label="Microfoon kiezen"
        value={conversation.deviceId}
        onchange={(e) => void chooseDevice(e.currentTarget.value)}
      >
        <option value="">Standaardmicrofoon</option>
        {#each conversation.devices.filter((d) => d.deviceId && d.deviceId !== "default") as device (device.deviceId)}
          <option value={device.deviceId}>{device.label || "Microfoon"}</option>
        {/each}
      </select>
    {/if}
    <button type="button" aria-label="Gesprek stoppen" onclick={toggle}
      >Stop</button
    >
  </div>
{:else if conversation.notice}
  <div class="voice-session notice" role="status" aria-live="polite">
    <span>{conversation.notice}</span>
    <button
      type="button"
      aria-label="Melding sluiten"
      onclick={() => (conversation.notice = "")}>OK</button
    >
  </div>
{/if}

<style>
  #conversationButton.on {
    color: var(--glow);
    border-color: var(--glow);
    box-shadow: 0 0 18px -2px var(--glow);
  }
  .voice-session {
    position: fixed;
    left: 50%;
    bottom: 5.5rem;
    transform: translateX(-50%);
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    max-width: calc(100vw - 32px);
    padding: 0.35rem 0.5rem 0.35rem 0.9rem;
    border-radius: 999px;
    border: 1px solid var(--glow);
    background: rgba(12, 10, 24, 0.85);
    color: var(--mist);
    font-size: 0.85rem;
    backdrop-filter: blur(8px);
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--glow);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .voice-session select {
    max-width: 10rem;
    background: transparent;
    color: inherit;
    border: 1px solid rgba(233, 230, 245, 0.25);
    border-radius: 999px;
    font-size: 0.8rem;
  }
  .voice-session button {
    border: 0;
    border-radius: 999px;
    padding: 0.3rem 0.8rem;
    background: var(--glow);
    color: var(--ink);
    cursor: pointer;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
