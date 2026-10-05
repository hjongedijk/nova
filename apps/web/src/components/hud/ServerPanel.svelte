<script lang="ts">
  import { onMount } from "svelte";
  import { dashboard, history } from "#lib/stores/dashboard.svelte.ts";
  import {
    drawChart,
    drawNet,
    glowHsl,
    prepareCanvas,
  } from "#lib/util/charts.ts";
  import { gb, pct, rate } from "#lib/util/format.ts";
  import Dial from "./Dial.svelte";

  const system = $derived(dashboard.system);
  const mem = $derived(
    system ? pct(system.memory.used, system.memory.total) : 0,
  );
  const disk = $derived(
    system?.disk ? pct(system.disk.used, system.disk.total) : null,
  );

  let chart: HTMLCanvasElement;
  let netchart: HTMLCanvasElement;

  // The graphs redraw every frame so they follow the entity's colour, but only when they can be seen.
  onMount(() => {
    let chartCtx = prepareCanvas(chart, 212, 60);
    let netCtx = prepareCanvas(netchart, 212, 44);
    const resize = () => {
      chartCtx = prepareCanvas(chart, 212, 60);
      netCtx = prepareCanvas(netchart, 212, 44);
    };
    window.addEventListener("resize", resize);
    let frame = 0;
    const draw = () => {
      if (window.innerWidth >= 1340 && chart.offsetParent) {
        const { h } = glowHsl();
        if (chartCtx) drawChart(chartCtx, h, history.cpu, history.memory);
        if (netCtx && netchart.offsetParent)
          drawNet(netCtx, h, history.rx, history.tx);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  });
</script>

<section class="hud" data-panel="server" aria-label="Server">
  <h2>Server <em>{system ? `belasting ${system.load[0]}` : ""}</em></h2>
  <div class="gauges">
    <Dial
      variant="gauge"
      id="gCpu"
      label="CPU"
      fraction={(system?.cpu ?? 0) / 100}
      text={system ? `${Math.round(system.cpu)}%` : "–"}
      title={system
        ? `${system.cores} kernen · belasting ${system.load.join(" / ")}`
        : undefined}
    />
    <Dial
      variant="gauge"
      id="gMem"
      label="Geheugen"
      fraction={mem / 100}
      text={system ? `${Math.round(mem)}%` : "–"}
      title={system
        ? `${gb(system.memory.used)} van ${gb(system.memory.total)} GB in gebruik`
        : undefined}
    />
    <Dial
      variant="gauge"
      id="gDisk"
      label="Schijf"
      fraction={(disk ?? 0) / 100}
      text={disk != null ? `${Math.round(disk)}%` : "–"}
      title={system?.disk
        ? `${gb(system.disk.used)} van ${gb(system.disk.total)} GB in gebruik`
        : undefined}
    />
  </div>
  <canvas id="chart" bind:this={chart} aria-hidden="true"></canvas>
  <p class="legend"><span>CPU</span><span>Geheugen</span></p>
  <div id="netBox" hidden={!system?.network}>
    <canvas id="netchart" bind:this={netchart} aria-hidden="true"></canvas>
    <p class="legend">
      <span
        >In<b>{system?.network ? rate(system.network.rxPerSec) : "–"}</b></span
      ><span
        >Uit<b>{system?.network ? rate(system.network.txPerSec) : "–"}</b></span
      >
    </p>
  </div>
</section>
