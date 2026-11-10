<script lang="ts">
  /*
   * One floating window: glass chrome, drag by the title bar, resize from the edges, minimize / maximize / close.
   * Position is a transform, so tiling reflows glide on the compositor; a drag writes the transform directly and
   * commits once on release.
   */
  import { scale } from "svelte/transition";
  import type { StreamBudget } from "#lib/windows/budget.ts";
  import Icon from "./Icon.svelte";
  import type { NovaWin, Rect } from "#lib/windows/manager.ts";
  import { windows } from "#lib/windows/windows.svelte.ts";
  import BrowserView from "./BrowserView.svelte";
  import ContentView from "./ContentView.svelte";
  import PageView from "./PageView.svelte";
  import ScreenView from "./ScreenView.svelte";
  import TerminalView from "./TerminalView.svelte";
  import VideoView from "./VideoView.svelte";

  let {
    win,
    rect,
    budget,
    focused,
    tiled,
    mission,
    sheet,
    index = 0,
  }: {
    win: NovaWin;
    rect: Rect;
    budget: StreamBudget;
    focused: boolean;
    tiled: boolean;
    mission: boolean;
    sheet: boolean;
    index?: number;
  } = $props();

  let node = $state<HTMLElement | null>(null);
  let dragging = $state(false);
  const reduce =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  const status = $derived(
    win.phase === "running"
      ? "bezig"
      : win.phase === "failed"
        ? "mislukt"
        : win.phase === "done"
          ? "klaar"
          : "",
  );

  type Gesture = {
    kind: "move" | "resize";
    edge: string;
    x: number;
    y: number;
    start: Rect;
    pointer: number;
  };
  let gesture: Gesture | null = null;
  let live: Rect | null = null;

  function begin(event: PointerEvent, kind: Gesture["kind"], edge = "") {
    if (event.button !== 0 || sheet || mission) return;
    if (kind === "move" && (event.target as Element).closest("button, a"))
      return;
    if (tiled && kind === "resize") return;
    if (gesture) return; // a second finger does not take over
    windows.focus(win.id);
    gesture = {
      kind,
      edge,
      x: event.clientX,
      y: event.clientY,
      start: { ...rect },
      pointer: event.pointerId,
    };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    dragging = true;
    event.preventDefault();
  }

  function track(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointer || !node) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const s = gesture.start;
    let next: Rect;
    if (gesture.kind === "move") next = { ...s, x: s.x + dx, y: s.y + dy };
    else {
      next = { ...s };
      if (gesture.edge.includes("e")) next.w = Math.max(280, s.w + dx);
      if (gesture.edge.includes("s")) next.h = Math.max(180, s.h + dy);
      if (gesture.edge.includes("w")) {
        next.w = Math.max(280, s.w - dx);
        next.x = s.x + s.w - next.w;
      }
    }
    live = next;
    node.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
    node.style.width = `${next.w}px`;
    node.style.height = `${next.h}px`;
  }

  function end(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const moved = live;
    gesture = null;
    live = null;
    dragging = false;
    if (!moved) return;
    // Dragging a tiled window lets it float where it was dropped.
    if (tiled) windows.setLayout("float");
    windows.move(win.id, moved);
  }

  function onkey(event: KeyboardEvent) {
    if (event.target !== event.currentTarget) return;
    const step = event.shiftKey ? 48 : 16;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (!move || tiled || sheet) return;
    event.preventDefault();
    windows.move(win.id, { x: rect.x + move[0], y: rect.y + move[1] });
  }
</script>

<section
  bind:this={node}
  class="nova-win"
  class:focused
  class:dragging
  class:mission
  class:sheet
  class:tiled
  data-kind={win.kind}
  data-win-id={win.id}
  data-phase={win.phase}
  aria-label={win.title || win.kind}
  style:transform={sheet ? null : `translate3d(${rect.x}px, ${rect.y}px, 0)`}
  style:width={sheet ? null : `${rect.w}px`}
  style:height={sheet ? null : `${rect.h}px`}
  style:z-index={mission ? 1 : win.z}
  style:--i={index}
  onpointerdowncapture={() => !mission && windows.focus(win.id)}
  out:scale={{ start: 0.97, duration: reduce ? 0 : 140, opacity: 0 }}
>
  <!-- The title bar is a drag handle; its buttons and the arrow keys (focusable via the window) are the accessible path. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header
    class="head"
    onpointerdown={(event) => begin(event, "move")}
    onpointermove={track}
    onpointerup={end}
    onpointercancel={end}
    ondblclick={(event) =>
      !(event.target as Element).closest("button") &&
      !sheet &&
      windows.maximize(win.id)}
    onkeydown={onkey}
    tabindex="-1"
  >
    <span class="icon" aria-hidden="true"><Icon name={win.kind} /></span>
    <h2 class="title">{win.title || "Venster"}</h2>
    {#if status && win.kind !== "video"}
      <span class="phase" data-phase={win.phase}
        ><span class="dot" aria-hidden="true"></span>{status}</span
      >
    {/if}
    <div class="controls">
      <button
        type="button"
        aria-label="Minimaliseren"
        onclick={() => windows.minimize(win.id)}
        ><Icon name="minimize" /></button
      >
      {#if !sheet}
        <button
          type="button"
          aria-label={win.mode === "maximized" ? "Herstellen" : "Maximaliseren"}
          onclick={() => windows.maximize(win.id)}
          ><Icon
            name={win.mode === "maximized" ? "restore" : "maximize"}
          /></button
        >
      {/if}
      <button
        type="button"
        class="close"
        aria-label="Sluiten"
        onclick={() => windows.close(win.id)}><Icon name="close" /></button
      >
    </div>
  </header>
  {#if win.phase === "running"}<span class="scan" aria-hidden="true"
    ></span>{/if}
  <div class="body">
    {#if win.kind === "browser"}
      <BrowserView {win} {budget} />
    {:else if win.kind === "screen"}
      <ScreenView {win} {budget} />
    {:else if win.kind === "terminal"}
      <TerminalView {win} />
    {:else if win.kind === "video"}
      <VideoView
        {win}
        onfloat={() => {
          windows.setLayout("float");
          windows.move(win.id, {
            x: windows.stage.w - 400,
            y: windows.stage.h - windows.stage.bottom - 250,
            w: 380,
            h: 240,
          });
        }}
      />
    {:else if win.kind === "page" || win.kind === "image"}
      <PageView {win} />
    {:else}
      <ContentView {win} />
    {/if}
  </div>
  {#if !sheet && !tiled && !mission && win.mode !== "maximized"}
    {#each ["e", "s", "w", "se", "sw"] as edge (edge)}
      <span
        class="grip"
        data-edge={edge}
        aria-hidden="true"
        onpointerdown={(event) => begin(event, "resize", edge)}
        onpointermove={track}
        onpointerup={end}
        onpointercancel={end}
      ></span>
    {/each}
  {/if}
  {#if mission}
    <button
      type="button"
      class="pick"
      aria-label={`${win.title || win.kind} tonen`}
      onclick={() => {
        windows.focus(win.id);
        windows.mission(false);
      }}
    ></button>
  {/if}
</section>

<style>
  .nova-win {
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    --ease-move: cubic-bezier(0.77, 0, 0.175, 1);
    position: absolute;
    left: 0;
    top: 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border: 1px solid
      color-mix(in srgb, var(--glow) 16%, rgb(233 230 245 / 10%));
    border-radius: 14px;
    background: rgb(7 9 19 / 82%);
    box-shadow:
      0 24px 60px -24px rgb(0 0 0 / 70%),
      0 2px 6px rgb(0 0 0 / 28%);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    pointer-events: auto;
    container-type: inline-size;
    transition:
      transform 300ms var(--ease-move),
      width 300ms var(--ease-move),
      height 300ms var(--ease-move),
      border-color 240ms ease,
      opacity 220ms var(--ease-out),
      scale 220ms var(--ease-out);
    will-change: transform;
    @starting-style {
      opacity: 0;
      scale: 0.96;
    }
  }
  .nova-win.focused {
    border-color: color-mix(in srgb, var(--glow) 42%, transparent);
    box-shadow:
      0 30px 80px -26px rgb(0 0 0 / 78%),
      0 2px 8px rgb(0 0 0 / 30%);
  }
  .nova-win[data-phase="failed"] {
    border-color: color-mix(in srgb, var(--alert) 50%, transparent);
  }
  .nova-win.dragging {
    transition: none;
    cursor: grabbing;
    user-select: none;
  }
  /* While a window moves, frames and players must not swallow the pointer. */
  .nova-win.dragging .body {
    pointer-events: none;
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 40px;
    padding: 0 6px 0 12px;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .head:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: -2px;
    border-radius: 14px 14px 0 0;
  }
  .tiled .head,
  .sheet .head {
    cursor: default;
  }
  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--glow) 12%, transparent);
    color: var(--glow);
  }
  .icon :global(svg),
  .controls :global(svg) {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .title {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--mist);
    font: 500 12.5px/1.2 var(--sans);
    letter-spacing: 0.01em;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .phase {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--dim);
    font: 400 11px/1 var(--sans);
  }
  .phase .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--good);
  }
  .phase[data-phase="running"] .dot {
    background: var(--glow);
    animation: beat 1.2s ease-in-out infinite;
  }
  .phase[data-phase="failed"] .dot {
    background: var(--alert);
  }
  @keyframes beat {
    50% {
      opacity: 0.3;
    }
  }
  @container (max-width: 340px) {
    .phase {
      display: none;
    }
  }
  .controls {
    flex: none;
    display: flex;
    gap: 2px;
  }
  .controls button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--dim);
    cursor: pointer;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      transform 120ms ease-out;
  }
  .controls button:active {
    transform: scale(0.94);
  }
  .controls button:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: -1px;
  }
  @media (hover: hover) and (pointer: fine) {
    .controls button:hover {
      color: var(--mist);
      background: rgb(255 255 255 / 8%);
    }
    .controls .close:hover {
      color: #fff;
      background: color-mix(in srgb, var(--alert) 70%, transparent);
    }
  }
  .scan {
    position: absolute;
    left: 0;
    top: 40px;
    width: 34%;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--glow), transparent);
    animation: scan 1.6s linear infinite;
    pointer-events: none;
    z-index: 1;
  }
  @keyframes scan {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid rgb(233 230 245 / 7%);
  }
  .grip {
    position: absolute;
    z-index: 2;
    touch-action: none;
  }
  .grip[data-edge="e"] {
    top: 40px;
    right: 0;
    bottom: 12px;
    width: 8px;
    cursor: ew-resize;
  }
  .grip[data-edge="w"] {
    top: 40px;
    left: 0;
    bottom: 12px;
    width: 8px;
    cursor: ew-resize;
  }
  .grip[data-edge="s"] {
    left: 12px;
    right: 12px;
    bottom: 0;
    height: 8px;
    cursor: ns-resize;
  }
  .grip[data-edge="se"] {
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
  }
  .grip[data-edge="sw"] {
    left: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nesw-resize;
  }
  /* Mission control: every window a tile; content keeps streaming but a click anywhere picks the window. */
  .nova-win.mission {
    transition-delay: calc(var(--i) * 35ms);
  }
  .pick {
    position: absolute;
    inset: 0;
    z-index: 3;
    border: 0;
    border-radius: inherit;
    background: transparent;
    cursor: pointer;
  }
  .pick:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: -2px;
  }
  @media (hover: hover) and (pointer: fine) {
    .pick:hover {
      box-shadow: inset 0 0 0 2px
        color-mix(in srgb, var(--glow) 60%, transparent);
    }
  }
  /* Phones: a full-width sheet above the composer. */
  .nova-win.sheet {
    position: fixed;
    left: 8px;
    right: 8px;
    top: auto;
    bottom: calc(var(--sheet-bottom, 96px) + env(safe-area-inset-bottom));
    height: min(62dvh, 560px);
    transform: none;
    border-radius: 16px;
    transition:
      opacity 220ms var(--ease-out),
      translate 260ms var(--ease-out);
    @starting-style {
      opacity: 0;
      translate: 0 24px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .nova-win,
    .nova-win.sheet {
      transition:
        border-color 200ms ease,
        opacity 160ms ease;
      @starting-style {
        opacity: 0;
        scale: 1;
        translate: 0 0;
      }
    }
    .scan,
    .phase[data-phase="running"] .dot {
      animation: none;
    }
  }
</style>
