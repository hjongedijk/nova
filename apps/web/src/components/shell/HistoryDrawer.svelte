<script lang="ts">
  import { tick } from "svelte";
  import { addMessage, showStage } from "#lib/chat/index.ts";
  import { getSessionId } from "#lib/chat/session.ts";
  import { forgetConversation } from "#lib/api/chat.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import { stopSpeech } from "#lib/voice/speaker.ts";

  let messages: HTMLElement;
  let closeButton: HTMLButtonElement;
  let seen = false;

  function close() {
    dialogs.history = false;
    document.querySelector<HTMLElement>("#menuButton")?.focus();
  }

  // Open: show the newest line and put focus on the close button. Growing answers keep the end in view.
  $effect(() => {
    const open = dialogs.history;
    void chat.history.length;
    void chat.history.at(-1)?.text;
    if (!messages) return;
    void tick().then(() => {
      messages.scrollTop = messages.scrollHeight;
    });
    if (open && !seen) closeButton?.focus();
    seen = open;
  });

  /* A fresh start: forget this conversation on the server and on screen. */
  async function newChat() {
    stopSpeech();
    try {
      await forgetConversation(getSessionId());
    } catch {
      /* the screen is cleared either way */
    }
    chat.history.length = 0;
    addMessage("assistant", "We beginnen opnieuw. Waar kan ik mee helpen?");
    showStage("", "", false);
    close();
  }
</script>

<svelte:document
  onkeydown={(event) => {
    if (event.key === "Escape" && dialogs.history) close();
  }}
/>

<aside
  id="history"
  class:open={dialogs.history}
  aria-label="Gesprek"
  aria-hidden={!dialogs.history}
>
  <div class="drawer-head">
    <h2>Gesprek</h2>
    <div class="drawer-actions">
      <button class="btn" id="newChat" type="button" onclick={newChat}
        >Nieuw gesprek</button
      >
      <button
        class="btn"
        id="historyClose"
        type="button"
        bind:this={closeButton}
        onclick={close}>Sluiten</button
      >
    </div>
  </div>
  <div id="messages" bind:this={messages}>
    {#if chat.history.length === 0}
      <div class="msg assistant">
        <div class="who">NOVA</div>
        <div>Systeem online.</div>
      </div>
    {/if}
    {#each chat.history as message, i (i)}
      <div class="msg {message.role}">
        <div class="who">{message.role === "assistant" ? "NOVA" : "Jij"}</div>
        <div class:assistant-content={message.role === "assistant"}>
          {message.text}
        </div>
      </div>
    {/each}
  </div>
</aside>
