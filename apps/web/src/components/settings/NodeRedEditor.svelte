<script lang="ts">
  import { onDestroy } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import {
    openNodeRedEditor,
    renewNodeRedEditor,
    closeNodeRedEditor,
  } from "#lib/api/node-red-editor.ts";

  let src = $state<"/api/node-red-editor/" | null>(null);
  let busy = $state(false);
  let message = $state("");
  let frameVersion = $state(0);
  let destroyed = false;
  let generation = 0;
  let touched = false;
  let renewing = false;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  let requests: Promise<unknown> = Promise.resolve();

  // Serialize cookie mutations so closing during a pending open revokes its grant,
  // and opening again waits for that revocation to finish.
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = requests.then(action);
    requests = result.catch(() => undefined);
    return result;
  }

  function stopRenewal() {
    if (renewalTimer !== undefined) clearInterval(renewalTimer);
    renewalTimer = undefined;
  }

  async function renew() {
    if (destroyed || !src || busy || renewing) return;
    const current = generation;
    renewing = true;
    try {
      await enqueue(renewNodeRedEditor);
      if (!destroyed && current === generation) message = "";
    } catch {
      if (!destroyed && current === generation) {
        message =
          "De editorsessie kon niet worden verlengd. Je kunt opnieuw laden.";
      }
    } finally {
      renewing = false;
    }
  }

  async function open() {
    if (destroyed || busy) return;
    const current = ++generation;
    touched = true;
    busy = true;
    message = "";
    try {
      const grant = await enqueue(openNodeRedEditor);
      if (destroyed || current !== generation) return;
      src = grant.url;
      frameVersion += 1;
      stopRenewal();
      renewalTimer = setInterval(() => void renew(), 5 * 60 * 1000);
    } catch {
      if (!destroyed && current === generation) {
        message = "Node-RED-editor is niet beschikbaar. Probeer het opnieuw.";
      }
    } finally {
      if (!destroyed && current === generation) busy = false;
    }
  }

  function close() {
    generation += 1;
    stopRenewal();
    src = null;
    busy = false;
    message = "";
    void enqueue(closeNodeRedEditor).catch(() => undefined);
  }

  onDestroy(() => {
    destroyed = true;
    generation += 1;
    stopRenewal();
    if (touched) void enqueue(closeNodeRedEditor).catch(() => undefined);
  });
</script>

<section class="editor-section" aria-label="Node-RED-floweditor">
  <h4>Floweditor</h4>
  <p class="hint">
    Bewerk flows hier. Nodebeheer blijft beschikbaar bij Nodes.
  </p>
  <div class="editor-toolbar">
    {#if src}
      <Button disabled={busy} onclick={open}>Opnieuw laden</Button>
      <Button onclick={close}>Sluiten</Button>
    {:else}
      <Button disabled={busy} onclick={open}
        >{busy ? "Editor openen…" : "Editor openen"}</Button
      >
      {#if busy}<Button onclick={close}>Sluiten</Button>{/if}
    {/if}
  </div>
  {#if message}
    <p role="status">{message}</p>
  {:else if src}
    <p class="hint" role="status">Je werkt in de Node-RED-floweditor.</p>
  {/if}
  {#if src}
    {#key frameVersion}
      <iframe
        {src}
        title="Node-RED-floweditor"
        referrerpolicy="same-origin"
        loading="eager"
        sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
      ></iframe>
    {/key}
  {/if}
</section>

<style>
  .editor-section {
    margin-top: 1.5rem;
  }
  .editor-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  iframe {
    display: block;
    width: 100%;
    height: min(70vh, 780px);
    border: 1px solid var(--border, #334155);
    border-radius: 0.5rem;
  }
</style>
