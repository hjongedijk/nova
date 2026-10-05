<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";

  const iss = $derived(dashboard.overview?.iss ?? null);
  const near = $derived(
    iss?.distanceFromHomeKm != null
      ? 1 - Math.min(1, iss.distanceFromHomeKm / 20015)
      : 0,
  );
</script>

<section class="hud" data-panel="iss" aria-label="Ruimtestation">
  <h2>
    ISS
    <em
      >{iss?.inRangeOfHome
        ? "boven je"
        : iss?.visibility === "daylight"
          ? "in zonlicht"
          : iss?.visibility === "eclipsed"
            ? "in schaduw"
            : ""}</em
    >
  </h2>
  <div id="issDist">
    {iss?.distanceFromHomeKm != null
      ? `${iss.distanceFromHomeKm.toLocaleString("nl-NL")} km van huis`
      : iss
        ? "Positie bekend"
        : "–"}
  </div>
  <p id="issMeta">
    {iss
      ? `${iss.speedKmh.toLocaleString("nl-NL")} km/u op ${iss.altitudeKm} km hoogte`
      : "Geen positie beschikbaar."}
  </p>
  <s class="bar" id="issBar"><u style:width="{Math.round(near * 100)}%"></u></s>
</section>
