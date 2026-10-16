<script lang="ts">
  import { onMount } from "svelte";
  import HoloViewer from "#components/holo/HoloViewer.svelte";
  import type { VizScene } from "#lib/holo/types.ts";
  import {
    fabModelUrl,
    getFabDesigns,
    getFabJobs,
    getFabPrinter,
    getFabProviders,
    type FabDesign,
    type FabJob,
    type FabPrinter,
    type FabProvider,
  } from "#lib/api/fabrication.ts";
  import { fail } from "./state.svelte.ts";

  let designs = $state<FabDesign[]>([]);
  let jobs = $state<FabJob[]>([]);
  let printer = $state<FabPrinter | null>(null);
  let providers = $state<FabProvider[]>([]);
  let selectedId = $state<string | null>(null);
  let loaded = $state(false);

  const selected = $derived(
    designs.find((d) => d.id === selectedId) ?? designs[0],
  );

  // A model scene for the shared holographic viewer: real geometry only.
  const scene = $derived.by<VizScene | null>(() => {
    const design = selected;
    if (!design) return null;
    return {
      schema: 1,
      id: `fab-${design.id}`,
      title: design.title,
      kind: "model",
      providerId: "fabrication",
      typeId: "design",
      revision: design.revision,
      updatedAt: new Date().toISOString(),
      models: [
        {
          id: "model",
          label: design.title,
          format: "stl",
          url: fabModelUrl(design.id, design.revision),
        },
      ],
      layers: [],
      modes: ["holographic", "realistic", "wireframe", "technical", "xray"],
      defaultMode: "holographic",
      units: "mm",
      notes: ["Weergave van de geometrie; geen gevalideerd printbestand."],
      actions: [],
      view: {
        highlights: [],
        annotations: [],
        hiddenLayers: [],
        rotations: [],
      },
    };
  });

  const STATES: Record<string, string> = {
    sliced: "geslicet",
    awaiting_approval: "wacht op goedkeuring",
    approved: "goedgekeurd",
    submitting: "wordt verstuurd",
    printing: "print",
    paused: "gepauzeerd",
    completed: "klaar",
    failed: "mislukt",
    cancelled: "geannuleerd",
    unknown: "onbekend: controleer de printer",
  };
  const minutes = (value: number | string) =>
    typeof value === "number"
      ? `${Math.floor(value / 60)} u ${value % 60} min`
      : "onbekend";

  async function load() {
    try {
      const [d, j, p, v] = await Promise.all([
        getFabDesigns(),
        getFabJobs(),
        getFabPrinter(),
        getFabProviders(),
      ]);
      designs = d.designs;
      jobs = j.jobs;
      printer = p.printer;
      providers = v.providers;
      loaded = true;
    } catch (cause) {
      fail(cause);
    }
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  });
</script>

<section class="fab" aria-label="3D-printen">
  <h2>3D-printen</h2>
  <p class="hint">
    Ontwerpen, controleren en printen gaat via het gesprek met NOVA (“ontwerp
    een beugel van 120 mm met vier gaten”). Hier zie je het resultaat. Een print
    start nooit zonder jouw uitdrukkelijke goedkeuring en een nieuwe
    bevestiging.
  </p>

  <h3>Printer</h3>
  {#if printer}
    <p role="status">
      {printer.model}: {printer.online
        ? printer.state
        : "offline"}{printer.simulated
        ? " (simulatie)"
        : ""}{printer.progressPercent !== undefined &&
      printer.state === "printing"
        ? ` · ${printer.progressPercent}%`
        : ""}{printer.remainingMinutes
        ? ` · nog ${printer.remainingMinutes} min`
        : ""}
    </p>
    {#if printer.note}<p>{printer.note}</p>{/if}
    {#if printer.error}<p role="alert">Printerfout: {printer.error}</p>{/if}
    {#if printer.materials?.length}
      <p>
        Filament: {printer.materials
          .map((m) => `${m.slot} ${m.type}`)
          .join(", ")}
      </p>
    {/if}
  {:else}<p>Laden…</p>{/if}

  <h3>Ontwerpen</h3>
  {#if designs.length}
    <div class="layout">
      <ul class="list">
        {#each designs as design (design.id)}
          <li>
            <button
              type="button"
              class:active={design.id === selected?.id}
              onclick={() => (selectedId = design.id)}
              >{design.title}
              <small>revisie {design.revision}/{design.revisions}</small
              ></button
            >
          </li>
        {/each}
      </ul>
      {#if selected}
        <div class="detail">
          <div class="view">
            {#if scene}{#key `${selected.id}:${selected.revision}`}<HoloViewer
                  {scene}
                />{/key}{/if}
          </div>
          <p>
            {selected.sizeMm.join(" × ")} mm · {selected.volumeCm3} cm³ · {selected.watertight
              ? "waterdicht"
              : "niet waterdicht"}{selected.supportsLikely
              ? " · waarschijnlijk supports nodig"
              : ""}
          </p>
          {#if selected.params}
            <p>
              Parameters ({selected.template}): {Object.entries(selected.params)
                .map(([k, v]) => `${k} ${v}`)
                .join(", ")}
            </p>
          {/if}
          {#if selected.origin}<p>
              Bron: {selected.origin.provider} · {selected.origin.creator ??
                "onbekende maker"} · licentie {selected.origin.license ??
                "onbekend"}
            </p>{/if}
          {#if selected.issues.length}
            <ul>
              {#each selected.issues as issue (issue)}<li>{issue}</li>{/each}
            </ul>
          {/if}
          <p class="hint">{selected.validation}</p>
          <p>
            <a
              href={`/api/fabrication/designs/${selected.id}/revisions/${selected.revision}/model.stl`}
              download>STL downloaden</a
            >
          </p>
        </div>
      {/if}
    </div>
  {:else if loaded}<p>Nog geen ontwerpen. Vraag NOVA er een te maken.</p>
  {:else}<p>Laden…</p>{/if}

  <h3>Printopdrachten</h3>
  {#if jobs.length}
    <ul>
      {#each jobs as job (job.id)}
        <li>
          <strong>{job.design}</strong> · {job.material} · {STATES[job.state] ??
            job.state} · {minutes(job.estimatedMinutes)}
          {#if job.estimatedFilamentGrams !== "onbekend"}· {job.estimatedFilamentGrams}
            g{/if}
          {#if job.outcome}<br /><small>{job.outcome}</small>{/if}
        </li>
      {/each}
    </ul>
  {:else}<p>Nog geen printopdrachten.</p>{/if}

  <h3>Bronnen voor bestaande modellen</h3>
  <ul>
    {#each providers as provider (provider.name)}
      <li>
        {provider.name}: {provider.status === "ready"
          ? "beschikbaar"
          : provider.status === "needs_token"
            ? "token nodig"
            : "niet ondersteund"}{provider.note ? ` — ${provider.note}` : ""}
      </li>
    {/each}
  </ul>
</section>

<style>
  .fab {
    margin: 1.5rem 0;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(10rem, 14rem) 1fr;
    gap: 1rem;
  }
  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.4rem;
    align-content: start;
  }
  .list button {
    width: 100%;
    text-align: left;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--line, #8883);
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .list button.active {
    border-color: var(--accent, #50e1ce);
  }
  .list small {
    display: block;
    opacity: 0.7;
  }
  .view {
    height: min(52vh, 26rem);
    border: 1px solid var(--line, #8883);
    border-radius: 8px;
    overflow: hidden;
  }
  @media (max-width: 40rem) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>
