<script lang="ts">
  import type { ToolUsageReport } from "@nova/contracts";
  import { getToolUsage } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import { RISK_LABEL } from "./labels.ts";
  let report = $state<ToolUsageReport | null>(null);
  let busy = $state(false);
  let error = $state("");
  let needle = $state("");
  let includeUnused = $state(false);
  const shown = $derived(
    (report?.tools || []).filter(
      (tool) =>
        (includeUnused || tool.attempts > 0) &&
        `${tool.name} ${tool.source}`
          .toLowerCase()
          .includes(needle.trim().toLowerCase()),
    ),
  );
  const stamp = (value: string | null) =>
    value
      ? new Date(value).toLocaleString("nl-NL")
      : "geen geregistreerde aanroep";
  async function load() {
    busy = true;
    error = "";
    try {
      report = await getToolUsage();
    } catch {
      error =
        "Gebruiksstatistieken konden niet worden geladen. Controleer je PIN.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="tool-usage" aria-label="Gebruik van gereedschappen">
  <h2>Gebruik van gereedschappen</h2>
  <p>
    NOVA toont eindresultaten uit maximaal 500 recente auditregels, binnen de
    laatste 2 MB. Alleen huidige gereedschappen staan hier. Stille
    dashboardacties worden niet geregistreerd.
  </p>
  <Button onclick={load} disabled={busy}>Gebruiksstatistieken laden</Button>
  {#if error}<p role="status">{error}</p>{/if}
  {#if report}
    <p>
      {report.scannedEntries} auditregels bekeken. Bereik: {stamp(
        report.oldestAt,
      )} tot {stamp(report.latestAt)}.
    </p>
    <p>
      OK betekent dat een aanroep een OK-resultaat meldde. Het bewijst geen
      wijziging op een apparaat. Voorbereiding, toestemmingsvragen en
      startmeldingen tellen niet mee.
    </p>
    {#if report.toolsTruncated}<p role="status">
        De lijst is begrensd tot 500 gereedschappen.
      </p>{/if}
    <label>Zoek in gebruik<input type="search" bind:value={needle} /></label>
    <label class="check"
      ><input type="checkbox" bind:checked={includeUnused} />Toon ook zonder
      geregistreerd gebruik</label
    >
    <ul>
      {#each shown as tool (tool.name)}
        <li>
          <h3>{tool.name}</h3>
          <p>
            {tool.source} · {RISK_LABEL[tool.risk]} · {tool.enabled
              ? "aan"
              : "uit"}
          </p>
          <p>
            {tool.attempts} afgeronde pogingen · {tool.okResults} OK-resultaten ·
            {tool.failedResults} foutresultaten.
          </p>
          <p>
            Aanroepcontext: gesprek {tool.contexts.chat}, instellingen {tool
              .contexts.settings}, achtergrond {tool.contexts.background},
            onbekend {tool.contexts.unknown}.
          </p>
          <p>
            Laatste: {stamp(tool.lastAt)}. Gemiddelde duur: {tool.averageDurationMs ===
            null
              ? "onbekend"
              : `${Math.round(tool.averageDurationMs)} ms`}.
          </p>
        </li>
      {:else}<li>Geen geregistreerd gebruik voor deze keuze.</li>{/each}
    </ul>
  {/if}
</section>

<style>
  .tool-usage {
    margin-block: 1.5rem;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    border-block-end: 1px solid var(--border, #555);
    padding-block: 1rem;
    overflow-wrap: anywhere;
  }
  label {
    display: grid;
    gap: 0.5rem;
    margin-block: 1rem;
  }
  .check {
    display: flex;
  }
  input[type="search"],
  :global(.tool-usage button) {
    min-height: 44px;
  }
</style>
