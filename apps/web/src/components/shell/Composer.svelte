<script lang="ts">
  import type { ChatAttachment } from "@nova/contracts";
  import { onMount } from "svelte";
  import { cards } from "#lib/chat/cards.svelte.ts";
  import { installReveal } from "#lib/modes/reveal.ts";
  import { ask, chat } from "#lib/stores/chat.svelte.ts";
  import {
    maybeHide,
    setChromeBusy,
    showChrome,
  } from "#lib/stores/chrome.svelte.ts";
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
  import { pressCore } from "#lib/voice/core.ts";

  let input: HTMLInputElement;
  let picker: HTMLInputElement;
  let attachments: ChatAttachment[] = $state([]);
  let fileError = $state("");
  let reading = $state(false);

  async function selectFiles(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const files = Array.from(target.files ?? []);
    target.value = "";
    reading = true;
    fileError = "";
    try {
      if (attachments.length + files.length > 3)
        throw new Error("Voeg maximaal drie bestanden toe.");
      const added: ChatAttachment[] = [];
      for (const file of files) {
        if (file.size > 16 * 1024)
          throw new Error(`${file.name}: maximaal 16 KiB per bestand.`);
        if (
          !file.name ||
          file.name.length > 200 ||
          Array.from(file.name).some((char) => char.charCodeAt(0) < 32) ||
          /[/\\]/.test(file.name)
        )
          throw new Error("Ongeldige bestandsnaam.");
        if (
          /\.(pdf|png|jpe?g|gif|webp|zip|docx?|xlsx?|pptx?)$/i.test(file.name)
        )
          throw new Error(
            "Kies tekstbestanden; PDF en afbeeldingen worden nog niet ondersteund.",
          );
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        if (content.includes("\0"))
          throw new Error(`${file.name}: kies een tekstbestand.`);
        added.push({ name: file.name, content });
      }
      attachments = [...attachments, ...added];
    } catch (error) {
      fileError =
        error instanceof TypeError
          ? "Kies UTF-8 tekstbestanden; PDF en afbeeldingen worden nog niet ondersteund."
          : (error as Error).message;
    } finally {
      reading = false;
      showChrome();
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (chat.busy || reading || (!shell.draft.trim() && !attachments.length))
      return;
    const text = shell.draft;
    const files = attachments;
    attachments = [];
    fileError = "";
    shell.draft = "";
    void ask(text, files);
  }

  // After an answer the cursor is back in the field, as in the prototype.
  let wasBusy = false;
  $effect(() => {
    const busy = chat.busy;
    if (wasBusy && !busy) queueMicrotask(() => input?.focus());
    wasBusy = busy;
  });

  onMount(() => {
    // Something keeps the controls up: a focused or filled field, an open menu or drawer, a waiting card.
    setChromeBusy(
      () =>
        document.activeElement === input ||
        shell.draft.trim() !== "" ||
        attachments.length > 0 ||
        reading ||
        !!fileError ||
        shell.menuOpen ||
        cards.length > 0 ||
        dialogs.history,
    );
    return installReveal(() => input);
  });
</script>

<form id="form" class="composer" onsubmit={submit}>
  <input
    type="file"
    multiple
    hidden
    bind:this={picker}
    onchange={selectFiles}
    accept="text/*,.txt,.md,.csv,.json,.log,.xml,.yaml,.yml,.js,.ts,.py,.sh,.ps1,.html,.css"
  />
  <button
    class="icon"
    type="button"
    aria-label="Bestanden bijvoegen"
    title="Tekstbestanden bijvoegen (max. 3 × 16 KiB)"
    disabled={chat.busy || reading}
    onclick={() => picker.click()}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true"
      ><path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9M6 15l9-9" /></svg
    >
  </button>
  <button
    id="micButton"
    class="icon"
    type="button"
    aria-label="Spreek met NOVA"
    hidden={!shell.speechSupported}
    onclick={pressCore}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  </button>
  <input
    id="input"
    autocomplete="off"
    aria-label="Bericht aan NOVA"
    placeholder="Zeg of typ iets…"
    bind:this={input}
    bind:value={shell.draft}
    disabled={chat.busy || reading}
    onfocus={() => showChrome()}
    onblur={() => setTimeout(maybeHide, 3500)}
  />
  <button
    id="sendButton"
    class="icon"
    type="submit"
    aria-label="Verstuur"
    disabled={chat.busy || reading}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  </button>
  {#if attachments.length || fileError || reading}
    <div class="attachments" aria-live="polite">
      {#each attachments as file, i (file)}
        <button
          type="button"
          disabled={chat.busy || reading}
          aria-label={`Verwijder ${file.name}`}
          onclick={() =>
            (attachments = attachments.filter((_, index) => index !== i))}
        >
          📎 {file.name} ×
        </button>
      {/each}
      {#if reading}<span>Bestanden lezen…</span>{/if}
      {#if fileError}<span role="alert">{fileError}</span>{/if}
    </div>
  {/if}
</form>
<button
  id="reveal"
  class="reveal"
  type="button"
  aria-label="Toon invoer en knoppen"
  title="Typ een bericht"
  onclick={() => {
    showChrome();
    input.focus();
  }}
></button>

<style>
  .composer {
    flex-wrap: wrap;
  }
  .attachments {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 12px 8px;
    font-size: 12px;
    color: var(--mist);
  }
  .attachments button {
    max-width: 100%;
    overflow-wrap: anywhere;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 4px 8px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
</style>
