<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import type { ModelMetricsReport } from "@nova/contracts";
  import { getModelMetrics } from "#lib/api/settings.ts";
  let report = $state<ModelMetricsReport | null>(null);
  let busy = $state(false);
  let error = $state("");
  async function refresh() {
    busy = true;
    error = "";
    try {
      report = await getModelMetrics();
    } catch {
      report = null;
      error = "Modelmetingen konden niet worden geladen.";
    } finally {
      busy = false;
    }
  }
  const number = (value: number | null, suffix = "") =>
    value === null
      ? "Onbekend"
      : `${new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 }).format(value)}${suffix}`;
  onMount(() => {
    void refresh();
  });
</script>

<section class="model-metrics" aria-label="Modelmetingen">
  <h2>Welke modellen antwoordden?</h2>
  <p>
    Metingen van de gateway over de afgelopen 24 uur. Een eerder antwoord
    garandeert geen beschikbaarheid of gratis toegang.
  </p>
  <Button onclick={refresh} disabled={busy}
    >{busy ? "Laden…" : "Metingen vernieuwen"}</Button
  >
  {#if error}<p role="status">{error}</p>{/if}
  {#if report}
    <p>
      Gratis route: {report.routeReady
        ? "geverifieerd en beschikbaar"
        : "geblokkeerd"}.
    </p>
    {#if report.lastResponse}
      <p>
        Laatste NOVA-modelantwoord sinds deze start: <strong
          >{report.lastResponse.model}</strong
        >
        {#if report.lastResponse.provider}({report.lastResponse.provider}){/if}
        · {number(report.lastResponse.latencyMs, " ms")} · {new Date(
          report.lastResponse.at,
        ).toLocaleString("nl-NL")}
      </p>
    {:else}<p>Nog geen NOVA-modelantwoord gemeten sinds deze start.</p>{/if}
    {#if !report.available}<p role="status">{report.error}</p>
    {:else if !report.models.length}<p>
        Nog geen modelmetingen in de afgelopen 24 uur.
      </p>
    {:else}
      <ul>
        {#each report.models as model, index (`${model.provider}/${model.model}/${index}`)}
          <li>
            <h3>{model.model}</h3>
            <p>
              {model.provider} · {model.enabled
                ? "In NOVA-beleid"
                : "Buiten NOVA-beleid"}
            </p>
            <p>
              {model.requests} aanvragen · {model.failures} mislukt · gemiddeld {number(
                model.averageMs,
                " ms",
              )}
            </p>
            <p>
              Eerste token: {number(model.firstTokenMs, " ms")} · snelheid: {number(
                model.tokensPerSecond,
                " tokens/s",
              )}
            </p>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="updated">
      Bijgewerkt: {new Date(report.updatedAt).toLocaleTimeString("nl-NL")}.
      Gatewaymetingen kunnen ook andere clients bevatten.
    </p>
  {/if}
</section>

<style>
  .model-metrics {
    margin-top: 2rem;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    padding: 1rem 0;
    border-bottom: 1px solid #30465a;
    overflow-wrap: anywhere;
  }
  h3 {
    margin: 0;
  }
  p {
    color: #a4bacd;
    line-height: 1.6;
  }
  strong {
    color: #e4edf6;
  }
  .updated {
    font-size: 0.85rem;
  }
</style>
