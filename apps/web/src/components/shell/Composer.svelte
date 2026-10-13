<script lang="ts">
  import { encodeAttachments } from "#lib/chat/attachments.ts";
  import {
    clipboardRequest,
    prepareClipboardText,
  } from "#lib/chat/clipboard.ts";
  import { friendlyChatError } from "#lib/chat/error-copy.ts";
  import { captureScreen } from "#lib/chat/screen-capture.ts";
  import { onMount } from "svelte";
  import { cards } from "#lib/chat/cards.svelte.ts";
  import { installReveal } from "#lib/modes/reveal.ts";
  import { ask, chat } from "#lib/stores/chat.svelte.ts";
  import { cancelActiveAsk } from "#lib/chat/ask.ts";
  import {
    maybeHide,
    setChromeBusy,
    showChrome,
  } from "#lib/stores/chrome.svelte.ts";
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";
  import { pressCore } from "#lib/voice/core.ts";
  import { stopSpeaking } from "#lib/voice/speaker.ts";
  import { stopListening } from "#lib/voice/recognition.ts";
  import { cancelAwait } from "#lib/voice/wake.ts";
  import type { ModelRoleId } from "@nova/contracts";
  import {
    getConversationLanguage,
    setConversationLanguage,
  } from "#lib/chat/session.ts";

  let input: HTMLInputElement;
  let picker: HTMLInputElement;
  let attachments: File[] = $state([]);
  let fileError = $state("");
  let reading = $state(false);
  let modelRole = $state<Exclude<ModelRoleId, "embedding"> | "">("");
  let responseLanguage = $state(getConversationLanguage());
  let clipboardText = $state("");
  let clipboardOpen = $state(false);
  let clipboardReading = $state(false);
  let clipboardTruncated = $state(false);
  let clipboardError = $state("");
  let screenImage = $state<Awaited<ReturnType<typeof captureScreen>> | null>(
    null,
  );
  let screenBusy = $state(false);
  let screenError = $state("");
  let screenQuestion = $state("");

  function clearScreen(): void {
    screenImage = null;
    screenError = "";
    screenQuestion = "";
  }

  async function takeScreen(): Promise<void> {
    clearScreen();
    clearClipboard();
    screenBusy = true;
    showChrome();
    try {
      screenImage = await captureScreen();
    } catch {
      screenError =
        "Schermopname mislukt of geweigerd. Sta schermdeling toe in je browser en probeer opnieuw.";
    } finally {
      screenBusy = false;
    }
  }

  async function sendScreen(): Promise<void> {
    if (!screenImage || chat.busy || screenBusy) return;
    const attachment = screenImage.attachment;
    const question =
      screenQuestion.trim() || "Wat staat er op deze schermopname?";
    clearScreen();
    await ask(question, [attachment], "text", "vision");
  }

  function clearClipboard(): void {
    clipboardText = "";
    clipboardOpen = false;
    clipboardTruncated = false;
    clipboardError = "";
  }

  async function readClipboard(): Promise<void> {
    clearClipboard();
    clearScreen();
    clipboardReading = true;
    showChrome();
    try {
      if (!navigator.clipboard?.readText)
        throw new Error("Clipboard unavailable");
      const prepared = prepareClipboardText(
        await navigator.clipboard.readText(),
      );
      if (!prepared.text) {
        clipboardError = "Het klembord bevat geen tekst.";
        return;
      }
      clipboardText = prepared.text;
      clipboardTruncated = prepared.truncated;
      clipboardOpen = true;
    } catch {
      clipboardError =
        "Klembord lezen mislukt. Sta toegang toe in je browser of plak de tekst zelf.";
    } finally {
      clipboardReading = false;
    }
  }

  async function useClipboard(
    action: "summary" | "translation",
  ): Promise<void> {
    if (!clipboardOpen || !clipboardText || clipboardReading || chat.busy)
      return;
    const request = clipboardRequest(action, responseLanguage);
    const attachment = { name: "klembord.txt", content: clipboardText };
    clearClipboard();
    await ask(request, [attachment], "text", "summary");
  }

  function changeLanguage(value: "nl" | "en"): void {
    responseLanguage = setConversationLanguage(value);
  }

  function stopAll(): void {
    stopSpeaking();
    stopListening();
    cancelAwait();
    cancelActiveAsk();
  }

  function selectFiles(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const files = [...attachments, ...Array.from(target.files ?? [])];
    target.value = "";
    fileError = "";
    if (files.length > 5) fileError = "Voeg maximaal vijf bestanden toe.";
    else if (files.some((file) => file.size > 10 * 1024 * 1024))
      fileError = "Maximaal 10 MiB per bestand.";
    else if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024)
      fileError = "Maximaal 20 MiB aan bijlagen per bericht.";
    else attachments = files;
    showChrome();
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (chat.busy || reading || (!shell.draft.trim() && !attachments.length))
      return;
    reading = true;
    fileError = "";
    try {
      const files = await encodeAttachments(attachments);
      if (chat.busy) return;
      const text = shell.draft;
      // Preserve the draft and files when a request fails, so it can be retried.
      reading = false;
      const sent = await ask(text, files, "text", modelRole || undefined);
      if (sent) {
        attachments = [];
        shell.draft = "";
      }
    } catch (error) {
      fileError = friendlyChatError(error, responseLanguage);
    } finally {
      reading = false;
    }
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
        clipboardReading ||
        clipboardOpen ||
        !!clipboardError ||
        screenBusy ||
        !!screenImage ||
        !!screenError ||
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
    accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,text/*,.txt,.md,.csv,.json,.log,.xml,.yaml,.yml,.js,.ts,.py,.sh,.ps1,.html,.css"
  />
  <select
    class="role-select language-select"
    aria-label="Gesprekstaal"
    value={responseLanguage}
    onchange={(event) =>
      changeLanguage(event.currentTarget.value === "en" ? "en" : "nl")}
    disabled={chat.busy || reading}
  >
    <option value="nl">Nederlands</option>
    <option value="en">English</option>
  </select>
  <select
    class="role-select"
    aria-label="Rol voor dit bericht"
    bind:value={modelRole}
    disabled={chat.busy || reading}
  >
    <option value="">Automatisch</option>
    <option value="conversation">Gesprek</option>
    <option value="code">Code</option>
    <option value="planning">Denken en plannen</option>
    <option value="summary">Samenvatten</option>
    <option value="vision">Beeld</option>
  </select>
  <button
    class="icon"
    type="button"
    aria-label="Bestanden bijvoegen"
    title="PDF, Word, afbeeldingen en tekst (max. 5 bestanden, 10 MiB per bestand)"
    disabled={chat.busy || reading}
    onclick={() => picker.click()}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true"
      ><path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9M6 15l9-9" /></svg
    >
  </button>
  <button
    class="icon"
    type="button"
    aria-label="Klembordhulp openen"
    title="Lees gekopieerde tekst voor samenvatten of vertalen"
    disabled={chat.busy || reading || clipboardReading}
    onclick={readClipboard}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="16" rx="2" />
      <path d="M9 5V3h6v2M8 10h8M8 14h8" />
    </svg>
  </button>
  <button
    class="icon"
    type="button"
    aria-label="Een schermopname maken"
    title="Kies een scherm of venster; NOVA maakt één momentopname"
    disabled={chat.busy || reading || screenBusy}
    onclick={takeScreen}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4M8 8h8" />
    </svg>
  </button>
  <button
    id="micButton"
    class="icon"
    type="button"
    aria-label="Spreek met NOVA"
    title="Tik om te spreken of houd F8 ingedrukt"
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
  {#if chat.busy || chat.uiState === "speaking"}
    <button
      id="stopButton"
      class="icon stop"
      type="button"
      aria-label={responseLanguage === "en" ? "Stop everything" : "Stop alles"}
      title={responseLanguage === "en" ? "Stop everything" : "Stop alles"}
      onclick={stopAll}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    </button>
  {/if}
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
          📎 {file.name} ({(file.size / 1024).toFixed(0)} KiB) ×
        </button>
      {/each}
      {#if reading}<span>Bestanden lezen…</span>{/if}
      {#if fileError}<span role="alert">{fileError}</span>{/if}
    </div>
  {/if}
  {#if clipboardReading || clipboardError || clipboardOpen}
    <div class="clipboard-help" aria-live="polite">
      {#if clipboardReading}<p>Klembord lezen…</p>{/if}
      {#if clipboardError}<p role="alert">{clipboardError}</p>{/if}
      {#if clipboardOpen}
        <p>
          <strong>Klembordhulp actief.</strong> Bekijk de tekst vóór verzenden. Herkende
          wachtwoorden en sleutels zijn gemaskeerd.
        </p>
        <pre>{clipboardText}</pre>
        {#if clipboardTruncated}<p>
            Alleen de eerste 12.000 tekens worden verzonden.
          </p>{/if}
        <div class="clipboard-actions">
          <button
            type="button"
            disabled={chat.busy}
            onclick={() => useClipboard("summary")}>Vat samen</button
          >
          <button
            type="button"
            disabled={chat.busy}
            onclick={() => useClipboard("translation")}
            >Vertaal naar {responseLanguage === "en"
              ? "Engels"
              : "Nederlands"}</button
          >
          <button type="button" onclick={clearClipboard}>Annuleren</button>
        </div>
        <p>
          Pas na je keuze gaat de gemaskeerde tekst via de gewone NOVA-chat naar
          de AI-route.
        </p>
      {/if}
    </div>
  {/if}
  {#if screenBusy || screenError || screenImage}
    <div class="screen-help" aria-live="polite">
      {#if screenBusy}<p>Eén schermbeeld maken…</p>{/if}
      {#if screenError}<p role="alert">{screenError}</p>{/if}
      {#if screenImage}
        <p>
          <strong>Schermopname klaar.</strong> Controleer het beeld. Er wordt pas
          iets verzonden als je hieronder kiest.
        </p>
        <img
          src={screenImage.preview}
          alt="Voorbeeld van de gekozen schermopname"
        />
        <input
          aria-label="Vraag over schermopname"
          placeholder="Wat wil je weten over dit beeld?"
          maxlength="500"
          bind:value={screenQuestion}
        />
        <div class="screen-actions">
          <button type="button" disabled={chat.busy} onclick={sendScreen}
            >Vraag NOVA</button
          >
          <button type="button" onclick={clearScreen}>Annuleren</button>
        </div>
        <p>
          Het beeld gaat alleen voor deze vraag naar de ingestelde geverifieerd
          gratis vision-route. Verberg gevoelige gegevens vóór de opname.
        </p>
      {/if}
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
  .composer:has(.clipboard-help, .screen-help) {
    border-radius: 18px;
  }
  .role-select {
    min-height: 44px;
    max-width: 190px;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0 8px;
    background: var(--panel);
    color: var(--text);
  }
  .language-select {
    max-width: 140px;
  }
  .stop {
    color: #ff897f;
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
  .clipboard-help {
    flex-basis: 100%;
    padding: 8px 12px 10px;
    color: var(--mist);
    font-size: 13px;
  }
  .clipboard-help p {
    margin: 4px 0 8px;
  }
  .clipboard-help pre {
    max-height: 100px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px;
    font: inherit;
  }
  .clipboard-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .clipboard-actions button {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 10px;
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  .screen-help {
    flex-basis: 100%;
    padding: 8px 12px 10px;
    color: var(--mist);
    font-size: 13px;
  }
  .screen-help p {
    margin: 4px 0 8px;
  }
  .screen-help img {
    display: block;
    max-width: 100%;
    max-height: 240px;
    object-fit: contain;
    margin-bottom: 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .screen-help input {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px;
    background: var(--panel);
    color: var(--text);
  }
  .screen-actions {
    display: flex;
    gap: 6px;
  }
  .screen-actions button {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 10px;
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
</style>
