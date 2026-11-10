<script lang="ts">
  /*
   * One live picture: subscribes to /api/live while it is on screen and not paused, decodes frames off the main
   * thread (createImageBitmap) and draws only the newest one per animation frame, so a burst never queues up.
   * The action overlay (click ripple, caret with typed text, key cap) sits on the picture in its own coordinates.
   */
  import type {
    LiveFrameHeader,
    LiveStatusMessage,
    NovaActionOverlay,
  } from "@nova/contracts";
  import { onDestroy, untrack } from "svelte";
  import { rememberFrame } from "#lib/windows/frames.ts";
  import { live } from "#lib/windows/live-client.ts";

  let {
    windowId,
    stream,
    display,
    fps,
    maxWidth,
    paused,
    action = null,
    onheader,
    onstate,
  }: {
    windowId: string;
    stream: "browser" | "desktop";
    display?: number;
    fps: number;
    maxWidth: number;
    paused: boolean;
    action?: (NovaActionOverlay & { at: number }) | null;
    onheader?: (header: LiveFrameHeader) => void;
    onstate?: (state: LiveStatusMessage["state"], reason?: string) => void;
  } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let box = $state({ w: 0, h: 0 });
  let picture = $state({ w: 0, h: 0 });
  let hasFrame = $state(false);
  let streamState = $state<LiveStatusMessage["state"]>("connecting");
  let pending: ImageBitmap | null = null;
  let decoding = false;
  let queued: Blob | null = null;
  let raf = 0;
  const key = `${untrack(() => windowId)}-${Math.random().toString(36).slice(2, 8)}`;

  function draw() {
    raf = 0;
    const bitmap = pending;
    pending = null;
    if (!bitmap || !canvas) return bitmap?.close();
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      picture = { w: bitmap.width, h: bitmap.height };
    }
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    hasFrame = true;
  }

  async function decode(blob: Blob) {
    if (decoding) {
      queued = blob; // only the newest waiting frame survives
      return;
    }
    decoding = true;
    try {
      const bitmap = await createImageBitmap(blob);
      pending?.close();
      pending = bitmap;
      if (!raf) raf = requestAnimationFrame(draw);
    } catch {
      /* a broken frame is skipped */
    } finally {
      decoding = false;
      const next = queued;
      queued = null;
      if (next) void decode(next);
    }
  }

  let stop: (() => void) | null = null;
  $effect(() => {
    if (paused) {
      stop?.();
      stop = null;
      return;
    }
    if (!stop)
      stop = live.subscribe(
        key,
        { stream, display, fps, maxWidth },
        {
          frame: (header, jpeg) => {
            rememberFrame(windowId, jpeg);
            onheader?.(header);
            void decode(jpeg);
          },
          status: (status) => {
            streamState = status.state;
            onstate?.(status.state, status.reason);
          },
        },
      );
    else live.budget(key, fps, maxWidth);
  });
  onDestroy(() => {
    stop?.();
    if (raf) cancelAnimationFrame(raf);
    pending?.close();
  });

  // Where the picture sits inside the box (object-fit: contain), for the overlay.
  const content = $derived.by(() => {
    if (!picture.w || !box.w || !box.h)
      return { x: 0, y: 0, w: box.w, h: box.h };
    const scale = Math.min(box.w / picture.w, box.h / picture.h);
    const w = picture.w * scale;
    const h = picture.h * scale;
    return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
  });

  // Each new action replays its overlay once.
  let shown = $state<(NovaActionOverlay & { at: number }) | null>(null);
  $effect(() => {
    if (!action) return;
    shown = action;
    const timer = setTimeout(
      () => {
        if (shown === action) shown = null;
      },
      action.kind === "type" ? 2600 : 1400,
    );
    return () => clearTimeout(timer);
  });
</script>

<div
  class="live"
  bind:clientWidth={box.w}
  bind:clientHeight={box.h}
  data-state={streamState}
>
  <canvas bind:this={canvas} class:ready={hasFrame} aria-hidden="true"></canvas>
  {#if !hasFrame}
    <div class="wait">
      <span class="pulse"></span>
      <span
        >{streamState === "offline"
          ? "Geen beeld"
          : "Beeld wordt opgehaald…"}</span
      >
    </div>
  {/if}
  {#if shown && hasFrame}
    {#key shown.at}
      {#if shown.x !== undefined && shown.y !== undefined}
        <div
          class="mark"
          data-kind={shown.kind}
          style:transform={`translate(${content.x + shown.x * content.w}px, ${content.y + shown.y * content.h}px)`}
        >
          {#if shown.kind === "click" || shown.kind === "move"}
            <span class="ripple"></span><span class="dot"></span>
          {:else if shown.kind === "type"}
            <span class="caret"></span>
            {#if shown.text}<span class="typed">{shown.text}</span>{/if}
          {/if}
        </div>
      {/if}
      {#if shown.kind === "key" && shown.key}
        <div class="keycap">{shown.key}</div>
      {:else if shown.kind === "scroll"}
        <div class="keycap">Scrollen</div>
      {/if}
    {/key}
  {/if}
</div>

<style>
  .live {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: #04050b;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 0;
    transition: opacity 240ms ease;
  }
  canvas.ready {
    opacity: 1;
  }
  .wait {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 10px;
    color: var(--dim);
    font: 400 12.5px/1.3 var(--sans);
  }
  .pulse {
    width: 28px;
    height: 2px;
    border-radius: 2px;
    background: var(--glow);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .live[data-state="offline"] .pulse {
    animation: none;
    background: var(--dim);
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.25;
      transform: scaleX(0.4);
    }
    50% {
      opacity: 1;
      transform: scaleX(1);
    }
  }
  .mark {
    position: absolute;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .dot {
    position: absolute;
    left: -5px;
    top: -5px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--glow);
    box-shadow: 0 0 0 2px rgb(4 5 11 / 70%);
    animation: dot 1.4s cubic-bezier(0.23, 1, 0.32, 1) forwards;
  }
  .ripple {
    position: absolute;
    left: -22px;
    top: -22px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1.5px solid var(--glow);
    animation: ripple 900ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
  }
  @keyframes ripple {
    from {
      opacity: 0.9;
      transform: scale(0.3);
    }
    to {
      opacity: 0;
      transform: scale(1.4);
    }
  }
  @keyframes dot {
    0%,
    70% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  .caret {
    position: absolute;
    left: -1px;
    top: -10px;
    width: 2px;
    height: 20px;
    background: var(--glow);
    animation: blink 900ms steps(2, start) infinite;
  }
  @keyframes blink {
    to {
      visibility: hidden;
    }
  }
  .typed {
    position: absolute;
    left: 8px;
    top: 14px;
    max-width: 260px;
    padding: 5px 9px;
    border-radius: 8px;
    background: rgb(6 8 17 / 86%);
    border: 1px solid color-mix(in srgb, var(--glow) 40%, transparent);
    color: var(--mist);
    font:
      500 12px/1.3 ui-monospace,
      "Cascadia Mono",
      Consolas,
      monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .keycap {
    position: absolute;
    left: 50%;
    bottom: 14px;
    translate: -50% 0;
    padding: 6px 12px;
    border-radius: 8px;
    background: rgb(6 8 17 / 86%);
    border: 1px solid var(--line);
    color: var(--mist);
    font: 500 12px/1 var(--sans);
    letter-spacing: 0.02em;
    animation: keycap 1.4s ease forwards;
  }
  @keyframes keycap {
    0% {
      opacity: 0;
    }
    12%,
    75% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ripple,
    .pulse {
      animation: none;
    }
    .ripple {
      opacity: 0;
    }
  }
</style>
