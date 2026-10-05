<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";
  import {
    cap,
    clock,
    isoWeek,
    moonPath,
    shortDate,
  } from "#lib/util/format.ts";
  import { now } from "./now.svelte.ts";

  const moon = $derived(dashboard.overview?.moon ?? null);
  const sun = $derived(dashboard.overview?.sun ?? null);

  const week = $derived.by(() => {
    const date = new Date(now.ms);
    const start = new Date(date.getFullYear(), 0, 0);
    return `week ${isoWeek(date)} · dag ${Math.floor((date.getTime() - start.getTime()) / 86400000)}`;
  });

  const day = $derived.by(() => {
    if (sun?.aboveHorizon && sun.nextSetting) {
      const minutes = Math.max(
        0,
        Math.round((Date.parse(sun.nextSetting) - now.ms) / 60000),
      );
      return `Zon onder over ${Math.floor(minutes / 60)}u ${minutes % 60}m`;
    }
    return sun?.nextRising ? `Zon op om ${clock(sun.nextRising)}` : "";
  });
</script>

<section class="hud" data-panel="maan" aria-label="Maan en dag">
  <h2>Maan en dag <em>{week}</em></h2>
  <div class="dialrow">
    <div>
      <div id="moonName">{moon ? cap(moon.name) : "–"}</div>
      <p id="moonMeta">
        {moon
          ? `${moon.illuminationPercent}% verlicht · volle maan ${shortDate(moon.nextFull)}`
          : ""}
      </p>
      <p id="dayMeta">{day}</p>
    </div>
    <svg id="moon" class="moon" viewBox="0 0 64 64" aria-hidden="true">
      <circle class="dark" cx="32" cy="32" r="24" />
      <path class="lit" d={moon ? moonPath(moon.fraction) : ""} />
      <circle class="rim" cx="32" cy="32" r="24" />
    </svg>
  </div>
</section>
