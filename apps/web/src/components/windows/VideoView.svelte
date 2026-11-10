<script lang="ts">
  import type { NovaVideoSource } from "@nova/contracts";
  import Icon from "./Icon.svelte";
  import type { NovaWin } from "#lib/windows/manager.ts";
  import {
    embedUrl,
    mediaUrl,
    playerCommand,
    playerOrigin,
  } from "#lib/windows/video.ts";

  let { win, onfloat }: { win: NovaWin; onfloat?: () => void } = $props();

  const source = $derived(win.data.video as NovaVideoSource | undefined);
  const embed = $derived(source ? embedUrl(source, location.origin) : null);
  const media = $derived(source ? mediaUrl(source) : null);
  const hlsNative = $derived(
    source?.provider !== "hls" ||
      document
        .createElement("video")
        .canPlayType("application/vnd.apple.mpegurl") !== "",
  );
  let frame = $state<HTMLIFrameElement | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let playing = $state(true);

  function toggle() {
    playing = !playing;
    if (video) {
      if (playing) void video.play().catch(() => (playing = false));
      else video.pause();
      return;
    }
    const command = source ? playerCommand(source.provider, playing) : null;
    const origin = source ? playerOrigin(source.provider) : null;
    if (command && origin) frame?.contentWindow?.postMessage(command, origin);
  }

  async function pip() {
    if (video && document.pictureInPictureEnabled) {
      try {
        await video.requestPictureInPicture();
        return;
      } catch {
        /* fall back to the floating window */
      }
    }
    onfloat?.();
  }
</script>

<div class="video">
  <div class="stage">
    {#if embed}
      <iframe
        bind:this={frame}
        src={embed}
        title={win.title || "Video"}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
      ></iframe>
    {:else if media && hlsNative}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={video}
        src={media}
        controls
        autoplay
        playsinline
        onplay={() => (playing = true)}
        onpause={() => (playing = false)}
      ></video>
    {:else}
      <div class="none">
        <p>Deze stream kan hier niet worden afgespeeld.</p>
        {#if media}<a href={media} target="_blank" rel="noopener noreferrer"
            >Openen in nieuw tabblad</a
          >{/if}
      </div>
    {/if}
  </div>
  <div class="controls">
    <button
      type="button"
      onclick={toggle}
      aria-label={playing ? "Pauzeren" : "Afspelen"}
    >
      <Icon name={playing ? "pause" : "play"} />
    </button>
    <span class="title">{win.title}</span>
    <button type="button" onclick={pip} aria-label="Zwevend afspelen"
      ><Icon name="pip" /></button
    >
    {#if typeof win.data.url === "string"}
      <a
        href={String(win.data.url)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Openen in nieuw tabblad"
      >
        <Icon name="external" />
      </a>
    {/if}
  </div>
</div>

<style>
  .video {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    background: #000;
  }
  iframe,
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: #000;
  }
  .none {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 10px;
    color: var(--dim);
    font: 400 13px/1.4 var(--sans);
  }
  .none p {
    margin: 0;
  }
  .none a {
    color: var(--glow);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    padding: 0 6px;
    color: var(--dim);
    font: 400 12px/1.2 var(--sans);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  button,
  a {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--mist);
    cursor: pointer;
    transition:
      background-color 150ms ease,
      transform 120ms ease-out;
  }
  button:active {
    transform: scale(0.95);
  }
  button:focus-visible,
  a:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: 1px;
  }
  @media (hover: hover) and (pointer: fine) {
    button:hover,
    a:hover {
      background: rgb(255 255 255 / 8%);
    }
  }
  button :global(svg),
  a :global(svg) {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
