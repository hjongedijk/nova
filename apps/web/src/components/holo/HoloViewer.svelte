<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { HoloEngine } from "#lib/holo/engine.ts";
  import { statusColor, STATUS_LABELS } from "#lib/holo/colors.ts";
  import { formatDistance } from "#lib/holo/measure.ts";
  import {
    availableModes,
    MODE_HINTS,
    MODE_LABELS,
    resolveMode,
  } from "#lib/holo/modes.ts";
  import type {
    HoloDimension,
    HoloLoadState,
    HoloMeasurement,
    HoloPart,
    HoloQuality,
    HoloSelectionInfo,
    HoloTheme,
    VizCameraPreset,
    VizMode,
    VizScene,
  } from "#lib/holo/types.ts";
  import HoloChart from "./HoloChart.svelte";
  import HoloGraphFallback from "./HoloGraphFallback.svelte";
  import HoloTable from "./HoloTable.svelte";

  /**
   * The universal holographic viewer. Give it a VizScene (graph, 3D model(s) or chart); it loads
   * three.js on demand, renders only when something changes and releases all GPU memory when it
   * is removed. See docs/holographic-engine.md for the full API.
   */
  let {
    scene,
    mode = $bindable(null),
    dimension = $bindable(null),
    theme = $bindable("dark"),
    quality = "auto",
    selected = $bindable(null),
    measuring = $bindable(false),
    showTable = $bindable(false),
    toolbar = true,
    onselect,
    onhotspot,
    onmeasure,
    onload,
  }: {
    scene: VizScene;
    /** Display mode; null = the scene's own. Bindable. */
    mode?: VizMode | null;
    /** Graphs only: flat or spatial. null = the scene's own (3d). Bindable. */
    dimension?: HoloDimension | null;
    theme?: HoloTheme;
    quality?: HoloQuality;
    /** Selected object id (graph node id, model part id or hotspot id). Bindable. */
    selected?: string | null;
    /** Click two points on a model to measure the distance between them. Bindable. */
    measuring?: boolean;
    /** Show the accessible table view instead of the picture. Bindable. */
    showTable?: boolean;
    /** Hide the built-in toolbar when the host page draws its own controls. */
    toolbar?: boolean;
    onselect?: (id: string | null, info: HoloSelectionInfo | null) => void;
    onhotspot?: (id: string) => void;
    onmeasure?: (measurements: HoloMeasurement[]) => void;
    onload?: (state: HoloLoadState) => void;
  } = $props();

  let host: HTMLDivElement | undefined = $state();
  let stage: HTMLDivElement | undefined = $state();
  let engine: HoloEngine | null = $state.raw(null);
  let load = $state<HoloLoadState>({
    state: "loading",
    progress: null,
    label: "3D-weergave voorbereiden…",
  });
  let noWebgl = $state(false);
  let fullscreen = $state(false);
  let hiddenLayers = $state<string[]>([]);
  let parts = $state<HoloPart[]>([]);
  let measurements = $state<HoloMeasurement[]>([]);
  let info = $state<HoloSelectionInfo | null>(null);
  let tooltip = $state<{ label: string; x: number; y: number } | null>(null);
  let announce = $state("");
  let tier = $state<"high" | "medium" | "low" | null>(null);

  const modes = $derived(availableModes(scene));
  const activeMode = $derived(resolveMode(scene, mode ?? scene.view.mode));
  const activeDimension = $derived<HoloDimension>(
    dimension ?? scene.view.dimension ?? "3d",
  );
  const resolvedTheme = $derived<"dark" | "light">(
    theme === "auto"
      ? typeof matchMedia === "function" &&
        matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme,
  );
  const isChart = $derived(scene.kind === "chart");
  const node = $derived(scene.nodes?.find((item) => item.id === selected));
  const hotspot = $derived(
    scene.hotspots?.find((item) => item.id === selected),
  );
  const PRESETS: [VizCameraPreset, string][] = [
    ["iso", "Isometrisch"],
    ["front", "Voorkant"],
    ["back", "Achterkant"],
    ["left", "Links"],
    ["right", "Rechts"],
    ["top", "Boven"],
    ["bottom", "Onder"],
  ];

  // The tools may change the view (mode, 2D/3D, layers, selection); follow those changes once.
  let seenMode: VizMode | undefined;
  let seenDimension: string | undefined;
  let seenLayers = "";
  let seenSelected: string | null | undefined;
  $effect(() => {
    const view = scene.view;
    untrack(() => {
      if (view.mode && view.mode !== seenMode) mode = view.mode;
      seenMode = view.mode;
      if (view.dimension && view.dimension !== seenDimension)
        dimension = view.dimension;
      seenDimension = view.dimension;
      const layers = JSON.stringify(view.hiddenLayers);
      if (layers !== seenLayers) hiddenLayers = [...view.hiddenLayers];
      seenLayers = layers;
      if (view.selected !== undefined && view.selected !== seenSelected)
        selected = view.selected;
      seenSelected = view.selected;
    });
  });

  onMount(() => {
    let disposed = false;
    const onFullscreen = () =>
      (fullscreen = document.fullscreenElement === stage);
    document.addEventListener("fullscreenchange", onFullscreen);
    if (isChart) {
      load = { state: "ready" };
      return () =>
        document.removeEventListener("fullscreenchange", onFullscreen);
    }
    void (async () => {
      const { HoloEngine, webglAvailable } =
        await import("#lib/holo/engine.ts");
      if (disposed || !host) return;
      if (!webglAvailable()) {
        noWebgl = true;
        load = { state: "ready" };
        if (scene.kind === "model") showTable = true;
        return;
      }
      try {
        const created = await HoloEngine.create({
          container: host,
          theme,
          quality,
          callbacks: {
            onSelect(id, picked) {
              selected = id;
              info = picked;
              announce = picked
                ? `Geselecteerd: ${picked.label}`
                : "Selectie gewist";
              onselect?.(id, picked);
            },
            onHover(id, label, position) {
              tooltip = id && position ? { label, ...position } : null;
            },
            onLoad(state) {
              load = state;
              onload?.(state);
              if (state.state === "ready") announce = "Visualisatie geladen";
              if (state.state === "error") announce = state.message;
            },
            onMeasure(list) {
              measurements = list;
              onmeasure?.(list);
            },
            onParts(list) {
              parts = list;
            },
            onQuality(next) {
              tier = next;
            },
            onHotspot(id) {
              onhotspot?.(id);
            },
          },
        });
        if (disposed) {
          created.dispose();
          return;
        }
        created.canvas.setAttribute("role", "application");
        created.canvas.setAttribute("aria-roledescription", "3D-weergave");
        created.canvas.setAttribute(
          "aria-label",
          `${scene.title}. Gebruik de tabelweergave voor een tekstversie.`,
        );
        engine = created;
      } catch {
        noWebgl = true;
        load = { state: "ready" };
        if (scene.kind === "model") showTable = true;
      }
    })();
    return () => {
      disposed = true;
      document.removeEventListener("fullscreenchange", onFullscreen);
      engine?.dispose();
      engine = null;
    };
  });

  $effect(() => {
    const e = engine;
    if (!e) return;
    const s = scene;
    const m = mode;
    const d = dimension;
    untrack(() => void e.setScene(s, { mode: m, dimension: d }));
  });
  $effect(() => {
    const e = engine;
    const t = theme;
    if (e) untrack(() => e.setTheme(t));
  });
  $effect(() => {
    const e = engine;
    const q = quality;
    if (e) untrack(() => e.setQuality(q));
  });
  $effect(() => {
    const e = engine;
    const layers = hiddenLayers;
    if (e) untrack(() => e.setHiddenLayers(layers));
  });
  $effect(() => {
    const e = engine;
    const id = selected;
    if (e) untrack(() => e.select(id, false));
  });
  $effect(() => {
    const e = engine;
    const on = measuring;
    if (e) untrack(() => e.setMeasuring(on));
  });

  export function fit(): void {
    engine?.fit();
  }
  export function focus(id: string, preset?: VizCameraPreset): void {
    engine?.focus(id, preset);
  }
  export function setCamera(preset: VizCameraPreset): void {
    engine?.setCamera(preset);
  }
  export function rotateObject(
    id: string,
    axis: "x" | "y" | "z",
    degrees: number,
  ): void {
    engine?.rotateObject(id, axis, degrees);
  }
  export function clearMeasurements(): void {
    engine?.clearMeasurements();
  }
  export function screenshot(): Promise<Blob | null> {
    return engine ? engine.screenshot() : Promise.resolve(null);
  }

  async function snapshot(): Promise<void> {
    const blob = await screenshot();
    if (!blob) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${scene.title.replace(/[^\w-]+/g, "-")}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage?.requestFullscreen?.();
  }

  const detailRows = $derived.by(() => {
    if (node)
      return [
        ["Status", STATUS_LABELS[node.status ?? "unknown"]],
        ["Soort", node.kind ?? "–"],
        ...Object.entries(node.detail ?? {}).map(([key, value]) => [
          key.replace(/_/g, " "),
          value === null ? "–" : String(value),
        ]),
      ];
    if (hotspot)
      return Object.entries(hotspot.detail ?? {}).map(([key, value]) => [
        key.replace(/_/g, " "),
        value === null ? "–" : String(value),
      ]);
    if (info?.size)
      return [
        [
          "Afmetingen",
          info.size.map((n) => formatDistance(n, scene.units)).join(" × "),
        ],
        ["Driehoeken", String(info.triangles ?? "–")],
      ];
    return [];
  });
  /** Statuses that occur in the scene, for the colour legend. */
  const legend = $derived(
    scene.kind === "graph"
      ? [
          ...new Set(
            (scene.nodes ?? []).map((item) => item.status ?? "unknown"),
          ),
        ]
      : [],
  );
  const selectedLabel = $derived(
    node?.label ?? hotspot?.label ?? info?.label ?? selected ?? "",
  );
</script>

<div
  class="viewer"
  class:fullscreen
  data-holo-viewer
  data-theme={resolvedTheme}
  data-engine={engine ? "ready" : noWebgl ? "none" : "starting"}
  bind:this={stage}
>
  {#if toolbar}
    <div class="bar" role="toolbar" aria-label="Weergave-instellingen">
      {#if modes.length > 1}
        <label class="field">
          <span>Modus</span>
          <select
            value={activeMode}
            onchange={(event) => (mode = event.currentTarget.value as VizMode)}
            title={MODE_HINTS[activeMode]}
          >
            {#each modes as option (option)}
              <option value={option}>{MODE_LABELS[option]}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if scene.kind === "graph"}
        <div class="seg" role="group" aria-label="Dimensie">
          {#each ["2d", "3d"] as d (d)}
            <button
              type="button"
              class="btn"
              aria-pressed={activeDimension === d}
              onclick={() => (dimension = d as HoloDimension)}
              >{d.toUpperCase()}</button
            >
          {/each}
        </div>
      {/if}
      {#if !isChart && !noWebgl}
        {#if activeDimension === "3d"}
          <label class="field">
            <span>Camera</span>
            <select
              onchange={(event) => {
                setCamera(event.currentTarget.value as VizCameraPreset);
                event.currentTarget.selectedIndex = 0;
              }}
            >
              <option value="" selected disabled>Kies…</option>
              {#each PRESETS as [value, label] (value)}
                <option {value}>{label}</option>
              {/each}
            </select>
          </label>
        {/if}
        <button type="button" class="btn" onclick={fit}>Passend</button>
      {/if}
      {#if scene.kind === "model" && !noWebgl}
        <button
          type="button"
          class="btn"
          aria-pressed={measuring}
          onclick={() => (measuring = !measuring)}>Meten</button
        >
      {/if}
      {#if scene.layers.length || parts.length > 1}
        <details class="layers">
          <summary class="btn">Lagen</summary>
          <div class="pop">
            {#each scene.layers as layer (layer.id)}
              <label>
                <input
                  type="checkbox"
                  checked={!hiddenLayers.includes(layer.id)}
                  onchange={(event) =>
                    (hiddenLayers = event.currentTarget.checked
                      ? hiddenLayers.filter((id) => id !== layer.id)
                      : [...hiddenLayers, layer.id])}
                />
                {layer.label}
              </label>
            {/each}
            {#if parts.length > 1}
              <p class="sub">Onderdelen</p>
              {#each parts as part (part.id)}
                <label>
                  <input
                    type="checkbox"
                    checked={part.visible}
                    onchange={(event) =>
                      engine?.setPartVisible(
                        part.id,
                        event.currentTarget.checked,
                      )}
                  />
                  {part.label}
                </label>
              {/each}
            {/if}
          </div>
        </details>
      {/if}
      {#if !isChart}
        <button
          type="button"
          class="btn"
          aria-pressed={showTable}
          onclick={() => (showTable = !showTable)}>Tabel</button
        >
      {/if}
      {#if !isChart && !noWebgl}
        <button
          type="button"
          class="btn"
          onclick={() => (theme = resolvedTheme === "dark" ? "light" : "dark")}
          aria-label="Wissel tussen donker en licht"
          >{resolvedTheme === "dark" ? "Licht" : "Donker"}</button
        >
        <button type="button" class="btn" onclick={() => void snapshot()}
          >Afbeelding</button
        >
      {/if}
      {#if !isChart}
        <button
          type="button"
          class="btn"
          aria-pressed={fullscreen}
          onclick={toggleFullscreen}
          >{fullscreen ? "Verkleinen" : "Beeldvullend"}</button
        >
      {/if}
      {#if tier && tier !== "high"}
        <span
          class="tag"
          title="De weergave is automatisch lichter gemaakt voor dit apparaat"
          >kwaliteit {tier === "medium" ? "gemiddeld" : "laag"}</span
        >
      {/if}
    </div>
  {/if}

  <div class="body">
    {#if isChart}
      <HoloChart {scene} theme={resolvedTheme} />
    {:else}
      <div
        class="canvas"
        bind:this={host}
        hidden={showTable}
        data-holo-host
      ></div>
      {#if noWebgl && !showTable && scene.kind === "graph"}
        <HoloGraphFallback
          {scene}
          theme={resolvedTheme}
          {selected}
          onselect={(id) => {
            selected = id;
            onselect?.(id, null);
          }}
        />
        <p class="notice" role="status">
          WebGL ontbreekt in deze browser; dit is de vlakke weergave.
        </p>
      {/if}
      {#if noWebgl && scene.kind === "model" && !showTable}
        <p class="notice" role="alert">
          3D-modellen vragen WebGL, en dat is hier niet beschikbaar. De tabel
          toont wat het model bevat.
        </p>
      {/if}
      {#if showTable}
        <HoloTable
          {scene}
          {selected}
          onselect={(id) => {
            selected = id;
            onselect?.(id, null);
          }}
        />
      {/if}
      {#if load.state === "loading" && !showTable && !noWebgl}
        <div class="overlay" role="status" aria-live="polite">
          <p>{load.label}</p>
          {#if load.progress !== null}
            <progress max="1" value={load.progress}></progress>
          {/if}
        </div>
      {/if}
      {#if load.state === "error" && !showTable}
        <div class="overlay err" role="alert">
          <p>{load.message}</p>
          <button type="button" class="btn" onclick={() => (showTable = true)}
            >Toon als tabel</button
          >
        </div>
      {/if}
      {#if tooltip && !showTable}
        <div
          class="tip"
          style:left="{tooltip.x + 14}px"
          style:top="{tooltip.y + 14}px"
        >
          {tooltip.label}
        </div>
      {/if}
      {#if selected && !showTable && (detailRows.length || selectedLabel)}
        <aside class="details" aria-label="Details van {selectedLabel}">
          <h3>
            <i
              style:background={node
                ? statusColor(node.status, resolvedTheme)
                : "var(--glow)"}
            ></i>
            {selectedLabel}
          </h3>
          <dl>
            {#each detailRows as [key, value] (key)}
              <dt>{key}</dt>
              <dd>{value}</dd>
            {/each}
          </dl>
          <button type="button" class="btn" onclick={() => (selected = null)}
            >Sluiten</button
          >
        </aside>
      {/if}
      {#if !showTable && !noWebgl && legend.length && load.state === "ready"}
        <div class="legend" aria-label="Legenda">
          {#if activeMode === "heatmap"}
            <span class="ramp" aria-hidden="true"></span>
            <span>{scene.heatLabel ?? "Waarde"}: laag naar hoog</span>
            <span class="nodata">grijs = geen gegevens</span>
          {:else}
            {#each legend as status (status)}
              <span class="lg"
                ><i style:background={statusColor(status, resolvedTheme)}
                ></i>{STATUS_LABELS[status]}</span
              >
            {/each}
          {/if}
        </div>
      {/if}
      {#if measurements.length && !showTable}
        <aside class="measures" aria-label="Metingen">
          <ul>
            {#each measurements as measurement (measurement.id)}
              <li>{formatDistance(measurement.distance, measurement.units)}</li>
            {/each}
          </ul>
          <button type="button" class="btn" onclick={clearMeasurements}
            >Wis metingen</button
          >
        </aside>
      {/if}
    {/if}
  </div>
  {#if toolbar && !isChart && !showTable && !noWebgl}
    <details class="keys">
      <summary>Bediening</summary>
      <p>
        Slepen = draaien (2D: verschuiven), scrollen of knijpen = zoomen,
        rechtermuisknop of twee vingers = verschuiven. Toetsen: pijltjes
        verschuiven, + en − zoomen, [ en ] kiezen het vorige of volgende object,
        0 past alles in beeld, Esc wist de selectie.
      </p>
    </details>
  {/if}
  <p class="sr" role="status" aria-live="polite">{announce}</p>
</div>

<style>
  .viewer {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 260px;
    background: #050a14;
    color: var(--mist);
    font-size: 13px;
  }
  .viewer[data-theme="light"] {
    background: #eef2f8;
    color: #06070f;
    --line: rgba(6, 7, 15, 0.18);
    --dim: #4a4866;
    --mist: #06070f;
  }
  .viewer.fullscreen {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .bar .btn {
    padding: 8px 12px;
    min-height: 34px;
    color: inherit;
  }
  .btn[aria-pressed="true"] {
    background: rgba(109, 220, 245, 0.18);
    border-color: var(--glow);
  }
  .seg {
    display: inline-flex;
  }
  .seg .btn + .btn {
    margin-left: -1px;
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--dim);
  }
  select {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 2px;
    padding: 7px 8px;
    min-height: 34px;
  }
  select option {
    color: #06070f;
  }
  .layers {
    position: relative;
  }
  .layers summary {
    list-style: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .layers summary::-webkit-details-marker {
    display: none;
  }
  .pop {
    position: absolute;
    z-index: 5;
    top: calc(100% + 4px);
    left: 0;
    min-width: 200px;
    max-height: 50vh;
    overflow: auto;
    padding: 10px 12px;
    background: #0d1523;
    color: var(--mist);
    border: 1px solid var(--line);
    box-shadow: 0 10px 30px #0008;
  }
  .viewer[data-theme="light"] .pop {
    background: #fff;
    color: #06070f;
  }
  .pop label {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 0;
  }
  .sub {
    margin: 8px 0 2px;
    color: var(--dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .tag {
    color: var(--amber);
    font-size: 12px;
  }
  .body {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .canvas {
    position: absolute;
    inset: 0;
  }
  .canvas[hidden] {
    display: none;
  }
  .overlay,
  .notice {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    padding: 10px 16px;
    background: rgba(5, 10, 20, 0.82);
    color: #e9e6f5;
    border: 1px solid var(--line);
    text-align: center;
    max-width: min(520px, 92%);
  }
  .overlay {
    top: 50%;
    transform: translate(-50%, -50%);
  }
  .overlay.err {
    border-color: var(--alert);
  }
  .overlay p,
  .notice {
    margin: 0 0 6px;
  }
  .notice {
    bottom: 10px;
    margin: 0;
    font-size: 12px;
  }
  progress {
    width: 220px;
    accent-color: var(--glow);
  }
  .tip {
    position: absolute;
    pointer-events: none;
    padding: 4px 8px;
    background: rgba(5, 10, 20, 0.9);
    border: 1px solid var(--line);
    color: #e9e6f5;
    font-size: 12px;
    max-width: 240px;
  }
  .details,
  .measures {
    position: absolute;
    left: 12px;
    bottom: 12px;
    max-width: min(320px, calc(100% - 24px));
    max-height: 55%;
    overflow: auto;
    padding: 12px 14px;
    background: rgba(5, 10, 20, 0.88);
    color: #e9e6f5;
    border: 1px solid var(--line);
  }
  .viewer[data-theme="light"] .details,
  .viewer[data-theme="light"] .measures {
    background: rgba(255, 255, 255, 0.92);
    color: #06070f;
  }
  .measures {
    left: auto;
    right: 12px;
  }
  .legend {
    position: absolute;
    right: 12px;
    top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: center;
    max-width: min(420px, calc(100% - 24px));
    padding: 6px 10px;
    font-size: 12px;
    color: #e9e6f5;
    background: rgba(5, 10, 20, 0.7);
    border: 1px solid var(--line);
  }
  .viewer[data-theme="light"] .legend {
    color: #06070f;
    background: rgba(255, 255, 255, 0.8);
  }
  .legend .lg i {
    display: inline-block;
    width: 9px;
    height: 9px;
    margin-right: 5px;
    border-radius: 50%;
  }
  .ramp {
    width: 70px;
    height: 8px;
    background: linear-gradient(90deg, #2b6cff, #6ddcf5, #ffcf6b, #ff5b3a);
  }
  .nodata {
    color: var(--dim);
  }
  .details h3 {
    margin: 0 0 8px;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow-wrap: anywhere;
  }
  .details h3 i {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 12px;
    margin: 0 0 10px;
  }
  dt {
    color: var(--dim);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .measures ul {
    margin: 0 0 8px;
    padding-left: 16px;
  }
  .keys {
    padding: 6px 12px;
    border-top: 1px solid var(--line);
    color: var(--dim);
    font-size: 12px;
  }
  .keys summary {
    cursor: pointer;
  }
  .keys p {
    margin: 6px 0 0;
    line-height: 1.5;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    margin: 0;
  }
  :global(.viewer canvas:focus-visible) {
    outline: 2px solid var(--glow);
    outline-offset: -2px;
  }
  @media (max-width: 640px) {
    .bar {
      padding: 6px 8px;
    }
    .details {
      right: 12px;
      max-width: none;
    }
  }
</style>
