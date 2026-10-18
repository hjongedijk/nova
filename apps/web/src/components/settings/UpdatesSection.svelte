<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import type { UpdateReport } from "@nova/contracts";
  import { novaVersionLabel } from "#lib/util/version.ts";
  import { getUpdates, checkUpdates } from "#lib/api/settings.ts";
  let report = $state<UpdateReport | null>(null);
  let busy = $state(false);
  let error = $state("");
  onMount(() => {
    void getUpdates()
      .then((value) => (report = value))
      .catch(() => (error = "Versie kon niet worden geladen."));
  });
  async function check() {
    busy = true;
    error = "";
    try {
      report = await checkUpdates();
    } catch {
      error = "Releasecontrole kon niet worden uitgevoerd.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="updates" aria-label="Versie en updates">
  <h2>Versie en updates</h2>
  {#if report}<p>
      Deze NOVA draait: <strong>{novaVersionLabel(report.running)}</strong>.
    </p>{/if}
  <Button disabled={busy} onclick={check}
    >{busy ? "Controleren…" : "Controleer op nieuwe release"}</Button
  >
  <p>
    Deze knop haalt openbare releasegegevens op bij GitHub. Een controle
    installeert niets; de uitslag wordt vijf minuten bewaard.
  </p>
  {#if error}<p role="status">{error}</p>{/if}
  {#if report?.error}<p role="status">{report.error}</p>{/if}
  {#if report?.latest}
    <p>
      Laatste opgehaalde release: <strong>{report.latest.version}</strong>.
      {#if report.updateAvailable === true}Een nieuwe versie is beschikbaar.
      {:else if report.updateAvailable === false}Deze installatie is gelijk of
        nieuwer.
      {:else}Een ontwikkelbuild kan niet met releasenummers worden vergeleken.{/if}
    </p>
    <a href={report.latest.url} target="_blank" rel="noopener noreferrer"
      >Bekijk release en downloads</a
    >
    {#if report.latest.notes}<details>
        <summary>Wat is veranderd?</summary>
        <pre>{report.latest.notes}</pre>
      </details>{/if}
  {/if}
  {#if report?.checkedAt}<p>
      Gecontroleerd: {new Date(report.checkedAt).toLocaleString("nl-NL")}.
    </p>{/if}
</section>

<style>
  .updates {
    margin: 1.5rem 0 2rem;
  }
  p {
    color: #a4bacd;
    line-height: 1.6;
  }
  strong {
    color: #e4edf6;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    padding: 1rem;
    background: #132538;
  }
  a {
    color: #8bd4f2;
  }
</style>
