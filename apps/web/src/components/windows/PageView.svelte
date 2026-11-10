<script lang="ts">
  /*
   * The result window: the real page in a frame when the site allows framing, otherwise the last live picture of
   * NOVA's browser, always with "Openen in nieuw tabblad".
   */
  import { onDestroy } from "svelte";
  import { lastFrame } from "#lib/windows/frames.ts";
  import Icon from "./Icon.svelte";
  import type { NovaWin } from "#lib/windows/manager.ts";

  let { win }: { win: NovaWin } = $props();
  const url = $derived(typeof win.data.url === "string" ? win.data.url : "");
  let frameable = $state<boolean | null>(null);
  let snapshot = $state("");
  let mode = $state<"frame" | "picture">("frame");

  $effect(() => {
    const target = url;
    frameable = null;
    if (!target) return;
    const controller = new AbortController();
    fetch(`/api/live/frameable?url=${encodeURIComponent(target)}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : { frameable: false }))
      .then((body: { frameable?: boolean }) => {
        frameable = body.frameable === true;
        mode = frameable ? "frame" : "picture";
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          frameable = false;
          mode = "picture";
        }
      });
    return () => controller.abort();
  });

  $effect(() => {
    const source =
      typeof win.data.snapshotOf === "string" ? win.data.snapshotOf : "";
    const blob = source ? lastFrame(source) : null;
    if (!blob) return;
    const object = URL.createObjectURL(blob);
    snapshot = object;
    return () => URL.revokeObjectURL(object);
  });
  onDestroy(() => snapshot && URL.revokeObjectURL(snapshot));

  const host = $derived.by(() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  });
</script>

<div class="page">
  <div class="bar">
    <div class="address" title={url}>
      {host}<span>{url.replace(/^https?:\/\/[^/]+/, "")}</span>
    </div>
    {#if frameable && snapshot}
      <div class="switch" role="group" aria-label="Weergave">
        <button
          type="button"
          aria-pressed={mode === "frame"}
          onclick={() => (mode = "frame")}>Pagina</button
        >
        <button
          type="button"
          aria-pressed={mode === "picture"}
          onclick={() => (mode = "picture")}>Beeld</button
        >
      </div>
    {/if}
    <a class="open" href={url} target="_blank" rel="noopener noreferrer">
      <Icon name="external" /><span>Openen in nieuw tabblad</span>
    </a>
  </div>
  <div class="body">
    {#if win.kind === "image"}
      <img src={url} alt={win.title} referrerpolicy="no-referrer" />
    {:else if frameable === null}
      <div class="note">Pagina wordt geladen…</div>
    {:else if mode === "frame" && frameable}
      <iframe
        src={url}
        title={win.title || host}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        loading="lazy"
      ></iframe>
    {:else if snapshot}
      <img class="shot" src={snapshot} alt={`Laatste beeld van ${host}`} />
    {:else}
      <div class="note">
        <p>{host} laat zich niet in een venster tonen.</p>
        <a href={url} target="_blank" rel="noopener noreferrer"
          >Openen in nieuw tabblad</a
        >
      </div>
    {/if}
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px 8px 12px;
  }
  .address {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 12px;
    border-radius: 14px;
    background: rgb(255 255 255 / 6%);
    color: var(--mist);
    font: 400 12px/28px var(--sans);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: text;
  }
  .address span {
    color: var(--dim);
  }
  .switch {
    display: flex;
    padding: 2px;
    border-radius: 9px;
    background: rgb(255 255 255 / 5%);
  }
  .switch button {
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--dim);
    font: 500 11.5px/1 var(--sans);
    cursor: pointer;
  }
  .switch button[aria-pressed="true"] {
    background: rgb(255 255 255 / 10%);
    color: var(--mist);
  }
  .open {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--glow) 14%, transparent);
    color: var(--mist);
    font: 500 12px/1 var(--sans);
    text-decoration: none;
    white-space: nowrap;
    transition:
      background-color 150ms ease,
      transform 120ms ease-out;
  }
  .open:active {
    transform: scale(0.97);
  }
  .open:focus-visible,
  .switch button:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: 1px;
  }
  @media (hover: hover) and (pointer: fine) {
    .open:hover {
      background: color-mix(in srgb, var(--glow) 24%, transparent);
    }
  }
  .open :global(svg) {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  @container (max-width: 460px) {
    .open span {
      display: none;
    }
  }
  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    background: #fff;
  }
  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #04050b;
  }
  img.shot {
    object-position: top center;
  }
  .note {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 10px;
    background: #04050b;
    color: var(--dim);
    font: 400 13px/1.4 var(--sans);
  }
  .note p {
    margin: 0;
  }
  .note a {
    color: var(--glow);
  }
</style>
