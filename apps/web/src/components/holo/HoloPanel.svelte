<script lang="ts">
  import { onMount } from "svelte";
  import { ask } from "#lib/chat/index.ts";
  import { exportUrl } from "#lib/holo/api.ts";
  import {
    closeHolo,
    holo,
    loadProviders,
    refresh,
    showProvider,
  } from "#lib/holo/store.svelte.ts";
  import HoloScene from "./HoloScene.svelte";

  let dialog: HTMLElement | undefined = $state();
  let opener: Element | null = null;

  $effect(() => {
    if (holo.open) {
      opener = document.activeElement;
      queueMicrotask(() => dialog?.focus());
      if (!holo.providers.length) void loadProviders();
    } else if (opener instanceof HTMLElement) {
      opener.focus();
      opener = null;
    }
  });

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      // Esc first leaves browser fullscreen (the browser handles that) and first clears a selection
      // in the viewer (which marks the event as handled); only then it closes the panel.
      if (
        event.key === "Escape" &&
        holo.open &&
        !event.defaultPrevented &&
        !document.fullscreenElement
      ) {
        event.preventDefault();
        closeHolo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const updated = $derived(
    holo.fetchedAt
      ? new Date(holo.fetchedAt).toLocaleTimeString("nl-NL", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "",
  );

  /** The shell focuses the composer on any typed character; inside this dialog that would steal the key. */
  function keepTyping(event: KeyboardEvent): void {
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    )
      event.stopPropagation();
  }

  async function sendAction(prompt: string): Promise<void> {
    closeHolo();
    await ask(prompt);
  }
</script>

{#if holo.open}
  <section class="backdrop" aria-label="Visualisatie">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="holo-title"
      tabindex="-1"
      bind:this={dialog}
      onkeydown={keepTyping}
    >
      <header>
        <h2 id="holo-title">{holo.scene?.title ?? "Visualisaties"}</h2>
        {#if holo.scene}
          <span class="meta">
            {holo.scene.refreshMs
              ? `Live · bijgewerkt ${updated}`
              : `Gemaakt ${updated}`}
          </span>
          {#if holo.scene.providerId !== "inline"}
            <button type="button" class="btn" onclick={() => void refresh()}
              >Ververs</button
            >
            <a class="btn" href={exportUrl(holo.scene.id, "json")} download
              >JSON</a
            >
            <a class="btn" href={exportUrl(holo.scene.id, "csv")} download
              >CSV</a
            >
          {/if}
          <button type="button" class="btn" onclick={() => (holo.scene = null)}
            >Andere</button
          >
        {/if}
        <button
          type="button"
          class="btn close"
          aria-label="Visualisatie sluiten"
          onclick={() => closeHolo()}>Sluiten</button
        >
      </header>
      {#if holo.error}<p class="err" role="alert">{holo.error}</p>{/if}
      {#if holo.scene}
        <div class="view">
          <HoloScene scene={holo.scene} />
        </div>
        {#if holo.scene.notes.length || holo.scene.actions.length}
          <footer>
            {#if holo.scene.notes.length}
              <ul class="notes">
                {#each holo.scene.notes as note (note)}<li>{note}</li>{/each}
              </ul>
            {/if}
            {#if holo.scene.actions.length}
              <div class="actions">
                <span>Vraag het aan NOVA:</span>
                {#each holo.scene.actions as action (action.id)}
                  <button
                    type="button"
                    class="btn"
                    onclick={() => void sendAction(action.prompt)}
                    >{action.label}</button
                  >
                {/each}
              </div>
            {/if}
          </footer>
        {/if}
      {:else}
        <div class="picker">
          <p>
            Kies wat je wilt zien. Alles komt uit echte gegevens van NOVA; wat
            onbekend is blijft onbekend. Je kunt NOVA ook vragen: “Toon mijn
            Proxmox” of “Laat het netwerk zien”.
          </p>
          {#each holo.providers as provider (provider.id)}
            <section class="provider" aria-labelledby="p-{provider.id}">
              <h3 id="p-{provider.id}">{provider.label}</h3>
              {#if !provider.available}
                <p class="dim">{provider.reason ?? "Niet beschikbaar."}</p>
              {/if}
              <ul>
                {#each provider.types as type (type.id)}
                  <li>
                    <button
                      type="button"
                      class="btn"
                      disabled={!provider.available || holo.busy}
                      onclick={() =>
                        void showProvider(`${provider.id}:${type.id}`)}
                      >{type.title}</button
                    >
                    <span class="dim">{type.description}</span>
                  </li>
                {/each}
              </ul>
            </section>
          {:else}
            <p class="dim">Visualisaties laden…</p>
          {/each}
        </div>
      {/if}
    </div>
  </section>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    padding: 12px;
    background: rgba(3, 8, 18, 0.82);
  }
  .dialog {
    display: flex;
    flex-direction: column;
    width: min(1280px, 100%);
    height: min(860px, 100%);
    background: #0d1523;
    border: 1px solid var(--line);
    box-shadow: 0 20px 80px #0009;
    color: var(--mist);
    outline: none;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0 auto 0 0;
    font-size: 1.1rem;
    overflow-wrap: anywhere;
  }
  .meta {
    color: var(--dim);
    font-size: 12px;
  }
  a.btn {
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }
  .view {
    flex: 1;
    min-height: 0;
  }
  footer {
    padding: 8px 14px 12px;
    border-top: 1px solid var(--line);
    font-size: 12.5px;
    max-height: 28%;
    overflow: auto;
  }
  .notes {
    margin: 0 0 8px;
    padding-left: 18px;
    color: var(--dim);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .err {
    margin: 0;
    padding: 8px 14px;
    color: var(--amber);
  }
  .picker {
    padding: 16px 18px 24px;
    overflow: auto;
  }
  .provider {
    margin-top: 18px;
  }
  .provider h3 {
    margin: 0 0 6px;
    color: var(--glow);
    font-size: 0.95rem;
  }
  .provider ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .provider li {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    align-items: center;
  }
  .dim {
    color: var(--dim);
    font-size: 12.5px;
    margin: 0;
  }
  @media (max-width: 640px) {
    .backdrop {
      padding: 0;
    }
    .dialog {
      height: 100%;
    }
  }
</style>
