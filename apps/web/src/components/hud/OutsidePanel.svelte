<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";
  import { WEATHER, clock, sunPosition } from "#lib/util/format.ts";
  import Dial from "./Dial.svelte";

  const weather = $derived(dashboard.overview?.weather ?? null);
  const sun = $derived(dashboard.overview?.sun ?? null);
  const temperature = $derived(weather?.temperature ?? null);
  const known = $derived(temperature != null);
  const place = $derived(
    weather?.forecast?.place && weather.forecast.place !== "bij jou thuis"
      ? weather.forecast.place
      : "",
  );
  const meta = $derived(
    weather && temperature != null
      ? [
          weather.humidity != null
            ? `${Math.round(weather.humidity)}% vocht`
            : null,
          weather.windSpeed != null
            ? `wind ${Math.round(weather.windSpeed)} ${weather.windUnit}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Geen weergegevens.",
  );

  // The forecast bars: temperature as height, chance of rain as the strip underneath.
  const bars = $derived.by(() => {
    const hours = weather?.forecast?.hours ?? [];
    if (!hours.length) return [];
    const temps = hours.map((h) => h.temperature);
    const low = Math.min(...temps);
    const span = Math.max(4, Math.max(...temps) - low);
    const slot = 212 / hours.length;
    return hours.map((hour, i) => {
      const height = 8 + ((hour.temperature - low) / span) * 22;
      return {
        x: i * slot + (slot - 11) / 2,
        height,
        rainOpacity: 0.12 + ((hour.rainChancePercent ?? 0) / 100) * 0.88,
        label: i % 3 === 0 ? hour.time.slice(0, 2) : null,
        title: `${hour.time} · ${Math.round(hour.temperature)}° · ${hour.rainChancePercent ?? 0}% kans op regen`,
      };
    });
  });

  const dot = $derived(sunPosition(sun));
</script>

<section class="hud" data-panel="buiten" aria-label="Buiten">
  <h2>Buiten <em>{place}</em></h2>
  <div class="dialrow">
    <div>
      <div id="wxState">
        {weather?.condition
          ? WEATHER[weather.condition] || weather.condition
          : ""}
      </div>
      <p id="wxMeta">{meta}</p>
    </div>
    <Dial
      fraction={known ? (temperature! + 10) / 50 : 0}
      text={known ? `${Math.round(temperature!)}°` : "–"}
    />
  </div>
  <svg id="forecast" viewBox="0 0 212 52" aria-label="Verwachting komende uren">
    {#each bars as bar (bar.x)}
      <rect
        class="t"
        x={bar.x}
        y={34 - bar.height}
        width="11"
        height={bar.height}><title>{bar.title}</title></rect
      >
      <rect
        class="r"
        x={bar.x}
        y="37"
        width="11"
        height="3"
        opacity={bar.rainOpacity}
      />
      {#if bar.label}<text x={bar.x + 5.5} y="50">{bar.label}</text>{/if}
    {/each}
  </svg>
  <svg id="sunArc" viewBox="0 0 200 50" aria-hidden="true">
    <line class="base" x1="0" y1="44" x2="200" y2="44" />
    <path class="path" d="M10 44 A90 40 0 0 1 190 44" />
    <circle
      id="sunDot"
      r="4"
      cx={dot?.cx ?? 100}
      cy={dot?.cy ?? 44}
      opacity={dot?.opacity ?? 0}
    />
  </svg>
  <p id="sunTimes">
    {sun
      ? `Opkomst ${clock(sun.nextRising)} · Ondergang ${clock(sun.nextSetting)}`
      : ""}
  </p>
</section>
