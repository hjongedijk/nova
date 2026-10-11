<script lang="ts">
  import { tick } from "svelte";
  import { addMessage, showStage } from "#lib/chat/index.ts";
  import { getSessionId } from "#lib/chat/session.ts";
  import { forgetConversation } from "#lib/api/chat.ts";
  import { chat } from "#lib/stores/chat.svelte.ts";
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import { stopSpeech } from "#lib/voice/speaker.ts";
  import type { CommunicationPreference } from "@nova/contracts";
  import {
    readCommunicationPreferences,
    saveCommunicationPreference,
  } from "#lib/chat/communication-preferences.ts";

  let messages: HTMLElement;
  let closeButton: HTMLButtonElement;
  let seen = false;
  let feedback = $state<Record<number, "up" | "down">>({});
  let savedPreference = $state<CommunicationPreference[]>(
    readCommunicationPreferences(),
  );
  const feedbackChoices: { id: CommunicationPreference; label: string }[] = [
    { id: "concise", label: "Kortere antwoorden" },
    { id: "fewer_jokes", label: "Minder grapjes" },
    { id: "more_detail", label: "Meer uitleg" },
    { id: "warmer", label: "Wat warmer" },
  ];

  function rememberFeedback(preference: CommunicationPreference): void {
    savedPreference = saveCommunicationPreference(preference);
  }

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
    feedback = {};
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
        {#if message.role === "assistant" && message.text.trim()}
          <div class="answer-feedback" aria-label="Was dit antwoord prettig?">
            <button
              class:chosen={feedback[i] === "up"}
              type="button"
              aria-label="Dit antwoord was goed"
              aria-pressed={feedback[i] === "up"}
              onclick={() => (feedback[i] = "up")}>👍</button
            >
            <button
              class:chosen={feedback[i] === "down"}
              type="button"
              aria-label="Dit antwoord was niet goed"
              aria-pressed={feedback[i] === "down"}
              onclick={() =>
                (feedback[i] = feedback[i] === "down" ? "up" : "down")}
              >👎</button
            >
          </div>
          {#if feedback[i] === "down"}
            <div
              class="feedback-preferences"
              role="group"
              aria-label="Wat wil je anders?"
            >
              {#each feedbackChoices as choice (choice.id)}
                <button
                  class:chosen={savedPreference.includes(choice.id)}
                  type="button"
                  aria-pressed={savedPreference.includes(choice.id)}
                  onclick={() => rememberFeedback(choice.id)}
                  >{choice.label}</button
                >
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
</aside>
