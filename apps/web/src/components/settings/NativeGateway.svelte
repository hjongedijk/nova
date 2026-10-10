<script lang="ts">
  import type {
    NativeGatewayReport,
    NativeSkillDocument,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getNativeGateway,
    getNativeSkillDocument,
  } from "#lib/api/settings.ts";
  let report = $state<NativeGatewayReport | null>(null);
  let document = $state<NativeSkillDocument | null>(null);
  let busy = $state(false);
  let error = $state("");
  async function load() {
    busy = true;
    error = "";
    document = null;
    try {
      report = await getNativeGateway();
    } catch {
      report = null;
      error = "OmniRoute-overzicht kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }
  async function read(id: string) {
    busy = true;
    error = "";
    try {
      document = await getNativeSkillDocument(id);
    } catch {
      document = null;
      error = "Documentatie kon niet worden geladen.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="OmniRoute-skills en prompts">
  <h2>Skills in OmniRoute</h2>
  <p>
    OmniRoute heeft eigen uitvoerbare skills en een aparte
    documentatiecatalogus. Dit overzicht voert niets uit.
  </p>
  <Button onclick={load} disabled={busy}
    >{busy ? "Laden…" : "OmniRoute-overzicht laden"}</Button
  >
  {#if error}<p role="status">{error}</p>{/if}
  {#if report}
    {#if !report.available}<p role="status">{report.error}</p>
    {:else}
      <h3>Uitvoerbare skills</h3>
      <p>Gateway-status kan maximaal één minuut achterlopen.</p>
      <p>
        Alleen NOVA en gedeelde skills. De gateway kan deze zelf gebruiken; dit
        overzicht schakelt ze niet in.
      </p>
      {#if report.truncated}<p>
          Alleen de eerste 200 gateway-items zijn gecontroleerd. Er kunnen meer
          NOVA-skills zijn.
        </p>{/if}
      {#if !report.skills.length}<p>
          Geen skills voor NOVA gevonden in deze pagina.
        </p>{/if}
      <ul>
        {#each report.skills as skill (skill.id)}<li>
            <strong>{skill.name}</strong> · {skill.version}<br
            />{skill.scope === "nova"
              ? "NOVA"
              : "Gedeeld met alle gateway-clients"} · {skill.enabled === null
              ? "Status onbekend"
              : skill.enabled
                ? "Ingeschakeld"
                : "Uitgeschakeld"} · modus {skill.mode || "onbekend"}
          </li>{/each}
      </ul>
      <h3>Gateway-prompt</h3>
      <p>
        Extra prompt voor alle gateway-clients: {report.prompt.enabled === null
          ? "status onbekend"
          : report.prompt.enabled
            ? "ingeschakeld"
            : "uitgeschakeld"}. Voorvoegsel: {report.prompt.prefixCharacters ??
          "onbekend"} tekens; achtervoegsel: {report.prompt.suffixCharacters ??
          "onbekend"} tekens.
      </p>
      <p>NOVA-instructies beheer je bij Skills; eigen geheugen bij Geheugen.</p>
      <h3>Documentatie</h3>
      <ul>
        {#each report.documentation as skill (skill.id)}<li>
            <strong>{skill.name}</strong>
            <p>{skill.description}</p>
            <Button onclick={() => read(skill.id)} disabled={busy}
              >Lees {skill.name}</Button
            >
          </li>{/each}
      </ul>
    {/if}
  {/if}
  {#if document}
    {#if document.available}<h3>{document.name}</h3>
      <pre>{document.documentation}</pre>
    {:else}<p role="status">{document.error}</p>{/if}
  {/if}
</section>

<style>
  section {
    margin-top: 2rem;
  }
  p {
    color: #a4bacd;
    line-height: 1.6;
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
  pre {
    padding: 1rem;
    background: #0a1622;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 30rem;
    overflow: auto;
  }
</style>
