<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";
  import { cap, nl } from "#lib/util/format.ts";
  import Dial from "./Dial.svelte";

  const air = $derived(dashboard.overview?.air ?? null);
  const meta = $derived.by(() => {
    if (!air) return "Geen luchtgegevens.";
    const parts: string[] = [];
    if (air.uv?.value != null)
      parts.push(`UV ${nl(air.uv.value)} (${air.uv.label})`);
    if (air.pollen && air.pollen.perM3 >= 1)
      parts.push(`pollen: ${air.pollen.name} ${air.pollen.label}`);
    if (air.pm25 != null) parts.push(`fijnstof ${nl(air.pm25, 0)} µg/m³`);
    return parts.join(" · ");
  });
  const value = $derived(air?.aqi?.value ?? null);
</script>

<section class="hud" data-panel="lucht" aria-label="Lucht">
  <h2>Lucht <em></em></h2>
  <div class="dialrow">
    <div>
      <div id="aqLabel">{air?.aqi?.label ? cap(air.aqi.label) : "–"}</div>
      <p id="aqMeta">{meta}</p>
    </div>
    <Dial
      fraction={Math.min(100, value ?? 0) / 100}
      text={value != null ? String(Math.round(value)) : "–"}
    />
  </div>
</section>
