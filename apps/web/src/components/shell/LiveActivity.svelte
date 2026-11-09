<script lang="ts">
  /*
   * Live activity windows: while NOVA works, each tool step opens a small glass window that is drawn
   * out of the entity on a thin tether, fills in as results arrive, settles to "klaar" and folds away a
   * few seconds after the answer. Click a window for its details; the pin keeps it on screen.
   */
  import { onMount } from "svelte";
  import { cubicOut } from "svelte/easing";
  import type { ToolPreview } from "@nova/contracts";
  import { activity, dispatchActivity } from "#lib/chat/activity.svelte.ts";
  import {
    layoutActivity,
    type Placement,
    type Rect,
  } from "#lib/chat/activity-layout.ts";
  import {
    formatDuration,
    monogram,
    PHASE_LABEL,
    type Activity,
  } from "#lib/chat/activity.ts";

  const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
  const ESTIMATE = 132;

  let vw = $state(1280);
  let vh = $state(720);
  let bounds = $state<Rect>({ left: 0, top: 0, right: 0, bottom: 0 });
  let core = $state({ x: 640, y: 360, r: 120 });
  let heights = $state<Record<string, number>>({});
  let openId = $state<string | null>(null);
  let reduced = $state(false);
  let sheet = $state<HTMLElement>();

  const compact = $derived(vw <= 700);
  // Large screens without OS scaling (4K at 100 %) grow the windows as a whole instead of leaving them tiny.
  const zoom = $derived(compact ? 1 : Math.min(1.75, Math.max(1, vw / 1920)));
  const panelWidth = $derived(
    Math.round(Math.min(340, Math.max(260, (vw * 0.17) / zoom)) * zoom),
  );
  const items = $derived(activity.value.items);
  const layout = $derived(
    layoutActivity({
      bounds,
      core,
      heights: items.map((item) => heights[item.id] ?? ESTIMATE),
      width: panelWidth,
      gap: compact ? 8 : 14,
      chipHeight: Math.ceil(30 * zoom),
      compact,
      maxVisible: 4,
    }),
  );
  const shown = $derived(
    layout.placements.map((place) => ({ place, item: items[place.index]! })),
  );
  const folded = $derived(items.slice(0, layout.folded));
  // The chip row keeps the latest few; older ones are only counted.
  const chipList = $derived(folded.slice(compact ? -8 : -6));
  const chipsHidden = $derived(folded.length - chipList.length);
  const open = $derived(items.find((item) => item.id === openId) ?? null);
  const latest = $derived(items.at(-1));
  const announcement = $derived(
    latest ? `${latest.label}: ${PHASE_LABEL[latest.phase]}` : "",
  );

  /** Read where the header, HUD columns, stage and composer are, and where the entity sits. */
  function measure(): void {
    vw = window.innerWidth;
    vh = window.innerHeight;
    const box = (selector: string): DOMRect | null => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden")
        return null;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 ? rect : null;
    };
    const pad = vw <= 700 ? 12 : 16;
    const header = box(".shell > header");
    let top = header ? header.bottom + 10 : pad;
    let left = pad;
    let right = vw - pad;
    const colLeft = box(".col-left:not(.empty)");
    const colRight = box(".col-right:not(.empty)");
    const panelsShown = !document.body.classList.contains("no-panels");
    if (panelsShown && colLeft && colLeft.width < vw * 0.5)
      left = Math.max(left, colLeft.right + 14);
    else if (panelsShown && colLeft) top = Math.max(top, colLeft.bottom + 10);
    if (panelsShown && colRight) right = Math.min(right, colRight.left - 14);
    let bottom = vh - pad;
    const stage = box(".stage");
    const composer = box(".composer");
    if (stage) bottom = Math.min(bottom, stage.top - 12);
    if (composer) bottom = Math.min(bottom, composer.top - 12);
    bounds = { left, top, right, bottom };
    const body = document.getElementById("core")?.getBoundingClientRect();
    core =
      body && body.width > 4
        ? {
            x: body.left + body.width / 2,
            y: body.top + body.height / 2,
            r: body.width / 2,
          }
        : {
            x: (left + right) / 2,
            y: (top + bottom) / 2,
            r: Math.min(right - left, bottom - top) / 4,
          };
  }

  onMount(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    reduced = motion.matches;
    const onMotion = () => (reduced = motion.matches);
    motion.addEventListener("change", onMotion);
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    for (const selector of [
      ".stage",
      ".composer",
      ".col-left",
      ".col-right",
      "#core",
    ]) {
      const el = document.querySelector(selector);
      if (el) resize.observe(el);
    }
    const classes = new MutationObserver(schedule);
    classes.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", onMotion);
      resize.disconnect();
      classes.disconnect();
      window.removeEventListener("resize", schedule);
    };
  });

  // A new window or a change in the stage may move the free area; measure again on the next frame.
  $effect(() => {
    void items.length;
    void activity.value.live;
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  });

  // The details close by themselves when their window is gone.
  $effect(() => {
    if (openId && !open) openId = null;
  });

  function openDetails(item: Activity): void {
    if (openId && openId !== item.id)
      dispatchActivity({ type: "hold", id: openId, held: false });
    openId = item.id;
    dispatchActivity({ type: "hold", id: item.id, held: true });
    requestAnimationFrame(() => sheet?.focus({ preventScroll: true }));
  }

  function closeDetails(): void {
    if (openId) dispatchActivity({ type: "hold", id: openId, held: false });
    openId = null;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && openId) {
      event.preventDefault();
      closeDetails();
    }
  }

  const elapsed = (item: Activity) =>
    formatDuration((item.endedAt ?? activity.now) - item.startedAt);

  /** The tether: from the entity's centre to the near edge of a window, as one transform. */
  function tether(place: Placement, height: number) {
    const tx = place.side === "left" ? place.x + place.width : place.x;
    const ty = place.y + Math.min(height, place.maxHeight) / 2;
    const dx = tx - core.x;
    const dy = ty - core.y;
    const length = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    return `translate3d(${core.x}px, ${core.y}px, 0) rotate(${angle}deg) scaleX(${length / 100})`;
  }

  /** Spawn: the window travels out of the entity, its glass sharpening as it arrives. */
  function spawn(node: HTMLElement, place: Placement) {
    const height = node.offsetHeight || ESTIMATE;
    const dx = core.x - (place.x + place.width / 2);
    const dy = core.y - (place.y + height / 2);
    const distance = Math.hypot(dx, dy);
    if (reduced) {
      node.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 160,
        easing: "ease",
      });
      return;
    }
    // Duration follows the distance travelled, clamped to stay brisk.
    node.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px) scale(0.42)`,
          opacity: 0,
          filter: "blur(6px)",
        },
        { opacity: 1, filter: "blur(0px)", offset: 0.55 },
        { transform: "none", opacity: 1, filter: "blur(0px)" },
      ],
      {
        duration: Math.round(Math.min(460, Math.max(280, distance * 0.9))),
        easing: EASE_OUT,
      },
    );
  }

  function drawTether(node: HTMLElement) {
    if (reduced) return;
    node.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 260,
      easing: "ease-out",
    });
  }

  /** Leaving: back toward the entity when the turn is over, upward into the chips when folded. */
  function retreat(
    _node: HTMLElement,
    { place, id }: { place: Placement; id: string },
  ) {
    // Still in the store means it was folded into the chips; gone means the turn is over.
    const toCore = !activity.value.items.some((other) => other.id === id);
    const dx = (core.x - (place.x + place.width / 2)) * 0.18;
    const dy = toCore ? (core.y - place.y) * 0.12 : -16;
    return {
      duration: reduced ? 140 : 220,
      easing: cubicOut,
      css: (t: number) => {
        const u = 1 - t;
        return reduced
          ? `opacity: ${t}; transform: translate3d(${place.x}px, ${place.y}px, 0);`
          : `opacity: ${t}; transform: translate3d(${place.x + dx * u}px, ${place.y + dy * u}px, 0) scale(${0.96 + 0.04 * t});`;
      },
    };
  }

  /** The snippet rolls slowly through its text only when it is taller than its window. */
  function roll(node: HTMLElement) {
    const inner = node.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const check = () => {
      const extra = inner.scrollHeight - node.clientHeight;
      node.classList.toggle("rolls", extra > 6);
      node.style.setProperty("--roll", `${-Math.max(0, extra)}px`);
      node.style.setProperty("--roll-time", `${Math.max(8, extra / 9)}s`);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(inner);
    return { destroy: () => observer.disconnect() };
  }

  const hits = (preview: ToolPreview | null) =>
    preview?.kind === "search" ? (preview.results ?? []) : [];
  const lines = (output: string | undefined, max: number) =>
    (output ?? "").split("\n").slice(-max);
  const iconFor = (item: Activity): string => {
    if (/^ha_|^home_/.test(item.tool)) return "home";
    if (/^proxmox_|^termix_(hosts|status)/.test(item.tool)) return "server";
    if (/^weather_|^air_/.test(item.tool)) return "weather";
    if (/^calendar_/.test(item.tool)) return "calendar";
    return item.kind;
  };
</script>

<svelte:window onkeydown={onKey} />

{#snippet icon(name: string)}
  <svg viewBox="0 0 16 16" aria-hidden="true">
    {#if name === "search"}
      <circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" />
    {:else if name === "page"}
      <path d="M4 1.75h5.5L12.25 4.5v9.75H4z" /><path
        d="M6.25 7.5h3.5M6.25 10h3.5"
      />
    {:else if name === "screen"}
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1" /><path
        d="M5.5 14h5M8 11.25V14"
      />
    {:else if name === "terminal"}
      <path d="m2.75 4.5 3 3-3 3" /><path d="M7.75 11.25h5.5" />
    {:else if name === "home"}
      <path d="M2.25 7.25 8 2.5l5.75 4.75" /><path
        d="M3.75 6.25v7.5h8.5v-7.5"
      />
    {:else if name === "server"}
      <rect x="2.25" y="2.5" width="11.5" height="4.25" rx="1" /><rect
        x="2.25"
        y="9.25"
        width="11.5"
        height="4.25"
        rx="1"
      /><path d="M4.75 4.6h.01M4.75 11.4h.01" />
    {:else if name === "weather"}
      <circle cx="6" cy="6" r="2.5" /><path
        d="M5 13.25h6.5a2.25 2.25 0 0 0 0-4.5 3 3 0 0 0-5.6-.5A2.5 2.5 0 0 0 5 13.25z"
      />
    {:else if name === "calendar"}
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1" /><path
        d="M2.25 6.75h11.5M5.25 1.75v3M10.75 1.75v3"
      />
    {:else}
      <circle cx="8" cy="8" r="2.25" /><path
        d="M8 1.75v2.5M8 11.75v2.5M1.75 8h2.5M11.75 8h2.5"
      />
    {/if}
  </svg>
{/snippet}

{#snippet pinIcon()}
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 2h4l-.5 4 2.5 2.25H4L6.5 6z" /><path d="M8 8.25V14" />
  </svg>
{/snippet}

{#snippet body(item: Activity, full: boolean)}
  {@const p = item.preview}
  {#if p?.kind === "search"}
    {#if p.query}<span class="aw-query">{p.query}</span>{/if}
    {#if hits(p).length}
      {@const list = full ? hits(p) : hits(p).slice(0, compact ? 2 : 4)}
      <span class="aw-hits">
        {#each list as hit, i (i)}
          <span class="aw-hit" style:--i={i}>
            <span class="aw-mono" aria-hidden="true"
              >{monogram(hit.domain)}</span
            >
            <span class="aw-hit-text">
              <span class="aw-hit-title">{hit.title}</span>
              {#if hit.domain}<span class="aw-dim">{hit.domain}</span>{/if}
            </span>
          </span>
        {/each}
      </span>
      {#if (p.total ?? 0) > list.length}
        <span class="aw-more">+{(p.total ?? 0) - list.length} meer</span>
      {/if}
    {:else if item.phase === "running"}
      <span class="aw-dim">Bronnen zoeken…</span>
    {:else if item.phase === "done"}
      <span class="aw-dim">Geen resultaten.</span>
    {/if}
  {:else if p?.kind === "page"}
    <span class="aw-site">
      <span class="aw-mono aw-mono-lg" aria-hidden="true"
        >{monogram(p.domain || p.title)}</span
      >
      <span class="aw-hit-text">
        <span class="aw-hit-title"
          >{p.title ||
            (item.phase === "running"
              ? "Pagina openen…"
              : "Pagina zonder titel")}</span
        >
        {#if p.domain}<span class="aw-dim">{p.domain}</span>{/if}
      </span>
    </span>
    {#if p.snippet}
      {#if full}
        <span class="aw-text">{p.snippet}</span>
      {:else}
        <span class="aw-snippet" use:roll><span>{p.snippet}</span></span>
      {/if}
    {/if}
  {:else if p?.kind === "screen"}
    {#if p.question}<span class="aw-query">{p.question}</span>{/if}
    {#if p.text}
      <span class={full ? "aw-text" : "aw-text aw-clamp"}>{p.text}</span>
    {:else if item.phase === "running"}
      <span class="aw-dim">Het scherm bekijken…</span>
    {/if}
  {:else if p?.kind === "terminal"}
    <span class="aw-term">
      {#if p.host}<span class="aw-term-host">{p.host}</span>{/if}
      {#if p.command}<span class="aw-term-cmd"
          ><span aria-hidden="true">$ </span>{p.command}</span
        >{/if}
      {#if p.output}
        {#each lines(p.output, full ? 40 : compact ? 3 : 7) as line, i (i)}
          <span class="aw-term-line" style:--i={i}>{line || " "}</span>
        {/each}
      {:else if item.phase === "running"}
        <span class="aw-term-line aw-caret" aria-hidden="true"></span>
      {/if}
      {#if p.exitCode !== undefined}
        <span class="aw-term-exit" data-ok={p.exitCode === 0}
          >exit {p.exitCode}</span
        >
      {/if}
    </span>
  {:else if p?.kind === "data"}
    {#if p.title}<span class="aw-data-title">{p.title}</span>{/if}
    {#if p.rows?.length}
      <span class="aw-rows">
        {#each full ? p.rows : p.rows.slice(0, compact ? 2 : 5) as row, i (i)}
          <span class="aw-row"
            ><span class="aw-dim">{row.label}</span><b>{row.value}</b></span
          >
        {/each}
      </span>
    {/if}
  {:else if p?.kind === "status" && p.message}
    <span class="aw-text aw-fail">{p.message}</span>
  {/if}
{/snippet}

<div class="aw-layer" class:compact aria-label="Wat NOVA nu doet" role="region">
  <p class="aw-live" aria-live="polite">{announcement}</p>

  {#if !compact}
    {#each shown as { place, item } (item.id)}
      <span
        class="aw-tether"
        data-phase={item.phase}
        style:transform={tether(place, heights[item.id] ?? ESTIMATE)}
        use:drawTether
        out:retreat={{ place, id: item.id }}
      ></span>
    {/each}
  {/if}

  {#if layout.chips && folded.length}
    <div
      class="aw-chips"
      style:transform={`translate3d(${layout.chips.x}px, ${layout.chips.y}px, 0)`}
      style:width={`${layout.chips.width}px`}
    >
      <span class="aw-chips-in" style:--aw-z={zoom}>
        {#if chipsHidden > 0}
          <span class="aw-chip aw-chip-count">+{chipsHidden}</span>
        {/if}
        {#each chipList as item (item.id)}
          <button
            type="button"
            class="aw-chip"
            data-phase={item.phase}
            onclick={() => openDetails(item)}
            title={`${item.label} · ${PHASE_LABEL[item.phase]}`}
          >
            <span class="aw-dot" aria-hidden="true"></span>{item.label}
          </button>
        {/each}
      </span>
    </div>
  {/if}

  {#each shown as { place, item } (item.id)}
    <article
      class="aw"
      data-kind={item.kind}
      data-phase={item.phase}
      data-side={place.side}
      class:pinned={item.pinned}
      class:opened={openId === item.id}
      style:transform={`translate3d(${place.x}px, ${place.y}px, 0)`}
      style:width={`${place.width}px`}
      style:--max-h={`${place.maxHeight / zoom}px`}
      style:--aw-z={zoom}
      bind:offsetHeight={heights[item.id]}
      onpointerenter={() =>
        dispatchActivity({ type: "hold", id: item.id, held: true })}
      onpointerleave={() =>
        openId !== item.id &&
        dispatchActivity({ type: "hold", id: item.id, held: false })}
      out:retreat={{ place, id: item.id }}
    >
      <div class="aw-in" use:spawn={place}>
        <header class="aw-head">
          <span class="aw-icon">{@render icon(iconFor(item))}</span>
          <span class="aw-label">{item.label}</span>
          <span class="aw-status">
            <span class="aw-dot" aria-hidden="true"></span>
            {PHASE_LABEL[item.phase]}
            <span class="aw-time">{elapsed(item)}</span>
          </span>
          <button
            type="button"
            class="aw-pin"
            aria-pressed={item.pinned}
            aria-label={item.pinned ? "Losmaken" : "Vastzetten"}
            title={item.pinned ? "Losmaken" : "Vastzetten"}
            onclick={() => dispatchActivity({ type: "pin", id: item.id })}
          >
            {@render pinIcon()}
          </button>
        </header>
        <button
          type="button"
          class="aw-body"
          aria-label={`${item.label}, ${PHASE_LABEL[item.phase]}. Details openen`}
          onclick={() => openDetails(item)}
        >
          {@render body(item, false)}
        </button>
        {#if item.phase === "running"}<span class="aw-scan" aria-hidden="true"
          ></span>{/if}
      </div>
    </article>
  {/each}

  {#if open}
    <div
      class="aw-sheet"
      role="dialog"
      aria-label={`${open.label}: details`}
      tabindex="-1"
      bind:this={sheet}
      data-phase={open.phase}
      style:--sheet-left={`${bounds.left}px`}
      style:--sheet-top={`${bounds.top}px`}
      style:--sheet-w={`${Math.max(0, bounds.right - bounds.left)}px`}
      style:--sheet-h={`${Math.max(0, bounds.bottom - bounds.top)}px`}
      style:--aw-z={zoom}
    >
      <header class="aw-head">
        <span class="aw-icon">{@render icon(iconFor(open))}</span>
        <span class="aw-label">{open.label}</span>
        <span class="aw-status">
          <span class="aw-dot" aria-hidden="true"></span>
          {PHASE_LABEL[open.phase]}
          <span class="aw-time">{elapsed(open)}</span>
        </span>
      </header>
      <div class="aw-sheet-body">
        {@render body(open, true)}
        {#if !open.preview}
          <span class="aw-dim">Geen verdere gegevens voor deze stap.</span>
        {/if}
      </div>
      <footer class="aw-sheet-foot">
        <span class="aw-dim">Stap {open.step} · <code>{open.tool}</code></span>
        <span class="aw-sheet-actions">
          <button
            type="button"
            class="aw-btn"
            aria-pressed={open.pinned}
            onclick={() => dispatchActivity({ type: "pin", id: open!.id })}
          >
            {open.pinned ? "Losmaken" : "Vastzetten"}
          </button>
          <button type="button" class="aw-btn" onclick={closeDetails}
            >Sluiten</button
          >
        </span>
      </footer>
    </div>
  {/if}
</div>

<style>
  .aw-layer {
    --aw-ease: cubic-bezier(0.23, 1, 0.32, 1);
    --aw-move: cubic-bezier(0.77, 0, 0.175, 1);
    --aw-glass: rgb(6 8 17 / 74%);
    --aw-edge: color-mix(in srgb, var(--glow) 24%, transparent);
    --aw-mono:
      ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
    position: fixed;
    inset: 0;
    z-index: 5;
    pointer-events: none;
    contain: layout style;
  }

  .aw-live {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    margin: 0;
  }

  /* ---------- tethers ---------- */
  .aw-tether {
    position: absolute;
    left: 0;
    top: 0;
    width: 100px;
    height: 1px;
    transform-origin: 0 50%;
    overflow: hidden;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--glow) 30%, transparent) 38%,
      color-mix(in srgb, var(--glow) 80%, transparent) 100%
    );
    opacity: 0.7;
    transition:
      transform 300ms var(--aw-move),
      opacity 400ms ease;
  }

  .aw-tether[data-phase="running"] {
    opacity: 1;
  }

  .aw-tether[data-phase="failed"] {
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--alert) 70%, transparent)
    );
  }

  /* data flowing out to the window while the step runs */
  .aw-tether[data-phase="running"]::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: 28%;
    background: linear-gradient(90deg, transparent, var(--glow), transparent);
    animation: aw-flow 1.1s linear infinite;
  }

  @keyframes aw-flow {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(360%);
    }
  }

  /* ---------- the window ---------- */
  .aw {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: auto;
    transition: transform 300ms var(--aw-move);
  }

  .aw-in {
    zoom: var(--aw-z, 1);
    position: relative;
    display: flex;
    flex-direction: column;
    max-height: var(--max-h, 60vh);
    overflow: hidden;
    border: 1px solid var(--aw-edge);
    border-radius: 12px;
    background: var(--aw-glass);
    box-shadow: 0 18px 38px -14px rgb(0 0 0 / 62%);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    transform-origin: 50% 50%;
    transition: border-color 400ms ease;
    container-type: inline-size;
  }

  /* a narrow window keeps the label whole; the duration lives in the details */
  @container (max-width: 300px) {
    .aw-time {
      display: none;
    }
  }

  /* HUD corner ticks, the same marks the side columns carry */
  .aw-in::before {
    content: "";
    position: absolute;
    left: 6px;
    top: 6px;
    width: 9px;
    height: 9px;
    border-left: 1px solid var(--glow);
    border-top: 1px solid var(--glow);
    border-top-left-radius: 3px;
    opacity: 0.7;
    pointer-events: none;
  }

  /* one soft flash of the edge when a step lands */
  .aw-in::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px var(--glow);
    opacity: 0;
    pointer-events: none;
  }

  .aw[data-phase="done"] .aw-in::after {
    animation: aw-settle 900ms ease-out;
  }

  .aw[data-phase="failed"] .aw-in {
    border-color: color-mix(in srgb, var(--alert) 55%, transparent);
  }

  .aw.pinned .aw-in,
  .aw.opened .aw-in {
    border-color: color-mix(in srgb, var(--glow) 55%, transparent);
  }

  @keyframes aw-settle {
    0% {
      opacity: 0.9;
    }
    100% {
      opacity: 0;
    }
  }

  .aw-scan {
    position: absolute;
    left: 0;
    top: 0;
    width: 38%;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--glow), transparent);
    animation: aw-scan 1.4s linear infinite;
    pointer-events: none;
  }

  @keyframes aw-scan {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(270%);
    }
  }

  .aw-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px 0 14px;
    min-width: 0;
  }

  .aw-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--glow) 12%, transparent);
    color: var(--glow);
  }

  .aw-icon :global(svg),
  .aw-pin :global(svg) {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .aw-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--mist);
    font: 500 12.5px/1.2 var(--sans);
    letter-spacing: 0.01em;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .aw-status {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--dim);
    font: 400 11.5px/1 var(--sans);
  }

  .aw-time {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }

  .aw-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--glow);
  }

  [data-phase="running"] .aw-dot {
    animation: aw-pulse 1.2s ease-in-out infinite alternate;
  }

  [data-phase="done"] .aw-dot {
    background: var(--good);
  }

  [data-phase="failed"] .aw-dot {
    background: var(--alert);
  }

  [data-phase="failed"] .aw-status {
    color: color-mix(in srgb, var(--alert) 80%, var(--mist));
  }

  @keyframes aw-pulse {
    from {
      opacity: 0.35;
    }
    to {
      opacity: 1;
    }
  }

  .aw-pin {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin: -4px 0;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--dim);
    cursor: pointer;
    opacity: 0.6;
    transition:
      opacity 150ms ease,
      color 150ms ease,
      transform 120ms ease-out;
  }

  .aw-pin[aria-pressed="true"] {
    color: var(--glow);
    opacity: 1;
  }

  .aw-pin[aria-pressed="true"] :global(svg) {
    fill: color-mix(in srgb, var(--glow) 35%, transparent);
  }

  .aw-pin:active,
  .aw-btn:active,
  .aw-chip:active {
    transform: scale(0.96);
  }

  @media (hover: hover) and (pointer: fine) {
    .aw:hover .aw-pin {
      opacity: 1;
    }
    .aw-pin:hover {
      color: var(--mist);
    }
    .aw-body:hover {
      background: rgb(233 230 245 / 3%);
    }
  }

  .aw-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    width: 100%;
    margin: 0;
    padding: 9px 14px 13px;
    border: 0;
    background: transparent;
    color: var(--dim);
    font: 400 12.5px/1.45 var(--sans);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    transition: background 150ms ease;
  }

  .aw-body:focus-visible,
  .aw-pin:focus-visible,
  .aw-chip:focus-visible,
  .aw-btn:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: -2px;
  }

  .aw-query {
    display: block;
    color: var(--mist);
    font: 300 15px/1.35 var(--sans);
    letter-spacing: -0.005em;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .aw-query::before {
    content: "“";
    color: var(--glow);
  }

  .aw-query::after {
    content: "”";
    color: var(--glow);
  }

  .aw-hits {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .aw-hit,
  .aw-site {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .aw-hit {
    animation: aw-hit 260ms var(--aw-ease) both;
    animation-delay: calc(var(--i, 0) * 45ms);
  }

  @keyframes aw-hit {
    from {
      opacity: 0;
      transform: translateY(5px);
    }
  }

  .aw-mono {
    flex: none;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 5px;
    border: 1px solid var(--aw-edge);
    color: var(--mist);
    font: 500 11px/1 var(--sans);
  }

  .aw-mono-lg {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    font-size: 14px;
    background: color-mix(in srgb, var(--glow) 10%, transparent);
  }

  .aw-hit-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .aw-hit-title {
    overflow: hidden;
    color: var(--mist);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .aw-site .aw-hit-title {
    font-weight: 500;
  }

  .aw-dim {
    overflow: hidden;
    color: var(--dim);
    font-size: 11.5px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .aw-more {
    color: var(--glow);
    font-size: 11.5px;
  }

  .aw-snippet {
    position: relative;
    display: block;
    max-height: calc(1.45em * 4);
    overflow: hidden;
    mask-image: linear-gradient(transparent, #000 14%, #000 80%, transparent);
  }

  .aw-snippet > span {
    display: block;
  }

  .aw-snippet:global(.rolls) > span {
    animation: aw-roll var(--roll-time, 12s) linear 1.2s infinite alternate;
  }

  @media (hover: hover) {
    .aw-body:hover .aw-snippet > span {
      animation-play-state: paused;
    }
  }

  @keyframes aw-roll {
    to {
      transform: translateY(var(--roll, 0));
    }
  }

  .aw-text {
    display: block;
    color: var(--mist);
    overflow-wrap: anywhere;
    white-space: pre-line;
  }

  .aw-clamp {
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .aw-fail {
    color: color-mix(in srgb, var(--alert) 70%, var(--mist));
  }

  .aw-term {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 9px 10px;
    border-radius: 8px;
    background: rgb(0 0 0 / 42%);
    color: #c9d6e6;
    font: 400 11.5px/1.45 var(--aw-mono);
    overflow: hidden;
  }

  .aw-term-host {
    color: var(--dim);
    font-size: 10.5px;
  }

  .aw-term-cmd {
    color: var(--glow);
    overflow-wrap: anywhere;
  }

  .aw-term-line {
    overflow: hidden;
    white-space: pre;
    text-overflow: ellipsis;
    animation: aw-line 180ms ease-out both;
    animation-delay: calc(var(--i, 0) * 28ms);
  }

  @keyframes aw-line {
    from {
      opacity: 0;
    }
  }

  .aw-caret {
    width: 7px;
    height: 13px;
    margin-top: 2px;
    background: var(--glow);
    animation: aw-pulse 0.6s steps(2, jump-none) infinite alternate;
  }

  .aw-term-exit {
    align-self: flex-end;
    margin-top: 4px;
    color: var(--good);
    font-size: 10.5px;
  }

  .aw-term-exit[data-ok="false"] {
    color: var(--amber);
  }

  .aw-data-title {
    color: var(--mist);
    font: 400 14px/1.3 var(--sans);
    overflow-wrap: anywhere;
  }

  .aw-rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .aw-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .aw-row b {
    overflow: hidden;
    color: var(--mist);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* ---------- chips ---------- */
  .aw-chips {
    position: absolute;
    left: 0;
    top: 0;
    display: flex;
    flex-wrap: nowrap;
    justify-content: center;
    gap: 6px;
    overflow: hidden;
    pointer-events: none;
  }

  .aw-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: none;
    max-width: 200px;
    height: 30px;
    padding: 0 12px;
    overflow: hidden;
    border: 1px solid var(--aw-edge);
    border-radius: 999px;
    background: var(--aw-glass);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: var(--mist);
    font: 400 12px/1 var(--sans);
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: pointer;
    pointer-events: auto;
    animation: aw-chip 200ms var(--aw-ease) both;
    transition: transform 120ms ease-out;
  }

  @keyframes aw-chip {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  /* ---------- details ---------- */
  .aw-sheet {
    position: absolute;
    left: calc(
      var(--sheet-left) + (var(--sheet-w) - min(600px, var(--sheet-w))) / 2
    );
    top: var(--sheet-top);
    width: min(calc(600px * var(--aw-z, 1)), var(--sheet-w));
    max-height: var(--sheet-h);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--glow) 40%, transparent);
    border-radius: 14px;
    background: rgb(6 8 17 / 96%);
    box-shadow: 0 30px 70px -20px rgb(0 0 0 / 75%);
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    pointer-events: auto;
    outline: none;
    animation: aw-sheet 220ms var(--aw-ease) both;
  }

  @keyframes aw-sheet {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.97);
    }
  }

  .aw-sheet > * {
    zoom: var(--aw-z, 1);
  }

  .aw-chip-count {
    cursor: default;
    color: var(--dim);
  }

  .aw-chips-in {
    zoom: var(--aw-z, 1);
    display: flex;
    gap: 6px;
    max-width: 100%;
  }

  .aw-sheet .aw-head {
    padding: 14px 16px 0;
  }

  .aw-sheet .aw-label {
    font-size: 14px;
  }

  .aw-sheet-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    padding: 12px 16px;
    overflow: auto;
    overscroll-behavior: contain;
    color: var(--dim);
    font: 400 13px/1.5 var(--sans);
    scrollbar-width: thin;
    scrollbar-color: var(--aw-edge) transparent;
  }

  .aw-sheet-body .aw-query {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }

  .aw-sheet-body .aw-hit-title {
    white-space: normal;
  }

  .aw-sheet-body .aw-term-line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .aw-sheet-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--line);
  }

  .aw-sheet-foot code {
    font: 400 11px/1 var(--aw-mono);
  }

  .aw-sheet-actions {
    display: flex;
    gap: 8px;
  }

  .aw-btn {
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: rgb(233 230 245 / 5%);
    color: var(--mist);
    font: 500 12.5px/1 var(--sans);
    cursor: pointer;
    transition:
      border-color 150ms ease,
      transform 120ms ease-out;
  }

  .aw-btn[aria-pressed="true"] {
    border-color: var(--glow);
    color: var(--glow);
  }

  @media (hover: hover) and (pointer: fine) {
    .aw-btn:hover,
    .aw-chip:hover {
      border-color: color-mix(in srgb, var(--glow) 60%, transparent);
    }
  }

  ::selection {
    background: color-mix(in srgb, var(--glow) 35%, transparent);
  }

  /* ---------- phone: one compact strip ---------- */
  .compact .aw-head {
    padding: 8px 6px 0 12px;
  }

  .compact .aw-body {
    padding: 6px 12px 10px;
    gap: 6px;
  }

  .compact .aw-query {
    font-size: 14px;
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .compact .aw-snippet {
    max-height: calc(1.45em * 2);
  }

  .compact .aw-chips {
    justify-content: flex-start;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .compact .aw-pin {
    width: 36px;
    height: 36px;
  }

  /* ---------- comfort ---------- */
  @media (prefers-reduced-motion: reduce) {
    .aw,
    .aw-tether {
      transition: none;
    }
    .aw-tether[data-phase="running"]::after,
    .aw-scan,
    .aw-caret,
    [data-phase="running"] .aw-dot {
      animation: none;
    }
    .aw-snippet:global(.rolls) > span {
      animation: none;
    }
    .aw-hit,
    .aw-term-line,
    .aw-chip,
    .aw-sheet {
      animation: aw-fade 150ms ease both;
      animation-delay: 0ms;
    }
    .aw-snippet {
      overflow: auto;
    }
  }

  @keyframes aw-fade {
    from {
      opacity: 0;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .aw-in,
    .aw-chip,
    .aw-sheet {
      background: rgb(8 10 20);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }

  @media (prefers-contrast: more) {
    .aw-in,
    .aw-sheet {
      border-color: var(--mist);
    }
  }

  /* As a wallpaper the desktop owns the cursor; the windows keep the plain arrow. */
  :global(body.wallpaper) .aw-layer :global(*) {
    cursor: default;
  }
</style>
