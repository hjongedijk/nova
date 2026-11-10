<script lang="ts">
  /*
   * Every NOVA window, the dock strip and mission control. Owns the frame budget: which live window may ask for
   * how many frames (focused full rate, small or background ones less, minimized and hidden ones none).
   */
  import { onMount } from "svelte";
  import { allocateBudget, type StreamBudget } from "#lib/windows/budget.ts";
  import Icon from "./Icon.svelte";
  import { isLive, layoutRects } from "#lib/windows/manager.ts";
  import { windows } from "#lib/windows/windows.svelte.ts";
  import NovaWindow from "./NovaWindow.svelte";

  const ws = $derived(windows.state);
  const stage = $derived(windows.stage);
  const sheet = $derived(stage.w < 640);
  const rects = $derived(layoutRects(ws, stage));
  let hidden = $state(false);

  // On a phone only the focused window is a sheet; the rest wait in the dock.
  // Mission control shows every window, the docked ones too.
  const shown = $derived(
    ws.mission && !sheet
      ? ws.windows
      : ws.windows.filter(
          (win) =>
            win.mode !== "minimized" && (!sheet || win.id === ws.focused),
        ),
  );
  const budgets = $derived(
    allocateBudget(
      ws.windows
        .filter((win) => isLive(win))
        .map((win) => {
          const rect = rects.get(win.id);
          return {
            id: win.id,
            kind: win.kind as "browser" | "screen",
            w: sheet ? stage.w - 16 : (rect?.w ?? 0),
            h: sheet ? stage.h * 0.5 : Math.max(0, (rect?.h ?? 0) - 90),
            minimized: !shown.includes(win),
            focused: win.id === ws.focused,
            z: win.z,
          };
        }),
      {
        hidden,
        mission: ws.mission,
        dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
      },
    ),
  );
  const none: StreamBudget = { fps: 0, maxWidth: 0, paused: true };

  onMount(() => {
    const resize = () => windows.measure();
    const visibility = () => (hidden = document.visibilityState === "hidden");
    visibility();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
    };
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented || !ws.windows.length)
      return;
    if (ws.mission) {
      windows.mission(false);
      event.preventDefault();
      return;
    }
    const target = event.target as Element | null;
    const inWindow = target?.closest?.(".nova-win");
    // Escape in the composer or a dialog belongs to them.
    if (!inWindow && target && target !== document.body) return;
    if (document.querySelector("dialog[open]")) return;
    const id = inWindow?.getAttribute("data-win-id") ?? ws.focused;
    if (!id) return;
    event.preventDefault();
    windows.close(id);
  }

  const live = (id: string) => {
    const win = ws.windows.find((w) => w.id === id);
    return !!win && isLive(win) && win.phase === "running";
  };
</script>

<svelte:window {onkeydown} />

{#if ws.windows.length}
  <div
    class="nova-windows"
    class:mission={ws.mission}
    style:--sheet-bottom={`${stage.bottom - 24}px`}
  >
    {#if ws.mission}
      <button
        type="button"
        class="backdrop"
        aria-label="Overzicht sluiten"
        onclick={() => windows.mission(false)}
      ></button>
    {/if}
    {#each shown as win, i (win.id)}
      <NovaWindow
        {win}
        rect={rects.get(win.id) ?? win}
        budget={budgets.get(win.id) ?? none}
        focused={ws.focused === win.id && !ws.mission}
        tiled={ws.layout === "tile"}
        mission={ws.mission}
        {sheet}
        index={i}
      />
    {/each}
    <nav class="nova-dock" class:alone={!shown.length} aria-label="Vensters">
      {#if !sheet}
        <button
          type="button"
          class="tool"
          aria-pressed={ws.layout === "tile"}
          aria-label={ws.layout === "tile" ? "Vrij plaatsen" : "Naast elkaar"}
          title={ws.layout === "tile" ? "Vrij plaatsen" : "Naast elkaar"}
          onclick={() =>
            windows.setLayout(ws.layout === "tile" ? "float" : "tile")}
          ><Icon name={ws.layout === "tile" ? "float" : "tile"} /></button
        >
        <button
          type="button"
          class="tool"
          aria-pressed={ws.mission}
          aria-label="Overzicht van alle vensters"
          title="Overzicht"
          onclick={() => windows.mission()}><Icon name="mission" /></button
        >
        <span class="sep" aria-hidden="true"></span>
      {/if}
      {#each ws.windows as win (win.id)}
        <button
          type="button"
          class="chip"
          class:min={win.mode === "minimized" ||
            (sheet && win.id !== ws.focused)}
          class:active={win.id === ws.focused && win.mode !== "minimized"}
          onclick={() =>
            win.id === ws.focused && win.mode !== "minimized" && !sheet
              ? windows.minimize(win.id)
              : windows.focus(win.id)}
          title={win.title}
        >
          <span class="ico" aria-hidden="true"><Icon name={win.kind} /></span>
          <span class="name">{win.title || win.kind}</span>
          {#if live(win.id)}<span class="rec" aria-label="live"></span>{/if}
        </button>
      {/each}
    </nav>
  </div>
{/if}

<style>
  .nova-windows {
    position: fixed;
    inset: 0;
    /* Above the shell and the activity windows, below toasts (20), dialogs and the takeover popup. */
    z-index: 19;
    pointer-events: none;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    background: rgb(3 4 10 / 62%);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    pointer-events: auto;
    cursor: default;
    transition: opacity 220ms ease;
    @starting-style {
      opacity: 0;
    }
  }
  .nova-dock {
    position: absolute;
    left: 50%;
    top: 14px;
    translate: -50% 0;
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: calc(100vw - 24px);
    padding: 5px;
    overflow-x: auto;
    border: 1px solid rgb(233 230 245 / 10%);
    border-radius: 14px;
    background: rgb(7 9 19 / 78%);
    box-shadow: 0 12px 30px -16px rgb(0 0 0 / 70%);
    backdrop-filter: blur(16px) saturate(140%);
    -webkit-backdrop-filter: blur(16px) saturate(140%);
    pointer-events: auto;
    scrollbar-width: none;
    z-index: 100000; /* above every window inside the layer */
  }
  .tool,
  .chip {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--dim);
    font: 500 11.5px/1 var(--sans);
    cursor: pointer;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      transform 120ms ease-out;
  }
  .tool {
    justify-content: center;
    width: 30px;
  }
  .tool[aria-pressed="true"] {
    color: var(--glow);
    background: color-mix(in srgb, var(--glow) 12%, transparent);
  }
  .chip {
    max-width: 170px;
    padding: 0 10px 0 8px;
  }
  .chip.active {
    color: var(--mist);
    background: rgb(255 255 255 / 8%);
  }
  .chip.min {
    opacity: 0.72;
  }
  .tool:active,
  .chip:active {
    transform: scale(0.96);
  }
  .tool:focus-visible,
  .chip:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: -1px;
  }
  @media (hover: hover) and (pointer: fine) {
    .tool:hover,
    .chip:hover {
      color: var(--mist);
      background: rgb(255 255 255 / 8%);
    }
  }
  .ico {
    display: grid;
    place-items: center;
    color: var(--glow);
  }
  .tool :global(svg),
  .ico :global(svg) {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rec {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--alert);
  }
  .sep {
    flex: none;
    width: 1px;
    height: 18px;
    margin: 0 3px;
    background: rgb(233 230 245 / 12%);
  }
  @media (max-width: 639px) {
    .nova-dock {
      top: auto;
      bottom: calc(
        var(--sheet-bottom) + min(62dvh, 560px) + 8px +
          env(safe-area-inset-bottom)
      );
    }
    .nova-dock.alone {
      bottom: calc(var(--sheet-bottom) + env(safe-area-inset-bottom));
    }
    .chip {
      max-width: 130px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .backdrop {
      backdrop-filter: none;
    }
  }
</style>
