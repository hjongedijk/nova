<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    NativeGatewayReport,
    NativeSkillDocument,
    NativeSkillMode,
    NativeSkillModePrepared,
  } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getNativeGateway,
    getNativeSkillDocument,
    prepareNativeSkillMode,
    confirmNativeSkillMode,
  } from "#lib/api/settings.ts";
  let report = $state<NativeGatewayReport | null>(null);
  let document = $state<NativeSkillDocument | null>(null);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let pending = $state<
    (NativeSkillModePrepared & { id: string; mode: NativeSkillMode }) | null
  >(null);
  let expired = $state(false);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const modeName = (mode: NativeSkillMode) =>
    ({ on: "Aan", off: "Uit", auto: "Automatisch" })[mode];
  async function prepare(id: string, mode: NativeSkillMode) {
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await prepareNativeSkillMode(id, mode);
      if (!result.ok || !result.action) {
        error = result.error || "Wijziging kon niet worden voorbereid.";
        return;
      }
      pending = { ...result, id, mode };
      expired = false;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(
        () => {
          expired = true;
        },
        Math.max(0, result.action.expiresAt - Date.now()),
      );
    } catch {
      error =
        "Wijziging kon niet worden voorbereid. Controleer je PIN en de koppeling.";
    } finally {
      busy = false;
    }
  }
  async function confirm(approve: boolean) {
    const current = pending;
    if (!current?.action) return;
    busy = true;
    error = "";
    try {
      const result = await confirmNativeSkillMode(
        current.id,
        current.action.sessionId,
        current.action.confirmationId,
        approve,
      );
      if (!result.ok)
        error = result.error || "Wijziging kon niet worden gecontroleerd.";
      else if (approve && result.verified === true) {
        const skill = report?.skills.find((item) => item.id === current.id);
        if (skill && result.mode && typeof result.enabled === "boolean") {
          skill.mode = result.mode;
          skill.enabled = result.enabled;
        }
        notice = `Modus opgeslagen en gecontroleerd. De gateway kan maximaal één minuut achterlopen.${result.auditWarning ? ` ${result.auditWarning}` : ""}`;
      } else notice = "Wijziging geannuleerd.";
    } catch {
      error =
        "Bevestiging kon niet worden afgerond. Controleer de status voordat je opnieuw wijzigt.";
    } finally {
      pending = null;
      clearTimeout(expiryTimer);
      busy = false;
    }
  }
  onDestroy(() => clearTimeout(expiryTimer));
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
  <Button onclick={load} disabled={busy || !!pending}
    >{busy ? "Laden…" : "OmniRoute-overzicht laden"}</Button
  >
  {#if error}<p role="status">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if pending}
    <div
      class="mode-confirm"
      role="group"
      aria-label="Native skillwijziging bevestigen"
    >
      <h3>{pending.name}: modus {modeName(pending.mode)}</h3>
      <p>
        Native skills kunnen code uitvoeren in de gateway. NOVA blijft zijn
        eigen toolbevestigingen gebruiken.
      </p>
      <p>
        {expired
          ? "Bevestiging verlopen. Annuleer en kies de wijziging opnieuw."
          : "Bevestig binnen 60 seconden. Deze toestemming geldt één keer."}
      </p>
      <Button onclick={() => confirm(true)} disabled={busy || expired}
        >Bevestig skillmodus</Button
      >
      <Button onclick={() => confirm(false)} disabled={busy}
        >Annuleer skillmodus</Button
      >
    </div>
  {/if}
  {#if report}
    {#if !report.available}<p role="status">{report.error}</p>
    {:else}
      <h3>Uitvoerbare skills</h3>
      <p>Gateway-status kan maximaal één minuut achterlopen.</p>
      <p>
        Alleen NOVA en gedeelde skills. Wijzig hier de modus van NOVA-skills.
        Gedeelde skills beheer je in OmniRoute.
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
                : "Uitgeschakeld"} · modus {skill.mode
              ? modeName(skill.mode)
              : "onbekend"}
            {#if skill.scope === "nova"}
              <div class="mode-buttons">
                {#each ["on", "off", "auto"] as mode (mode)}
                  <Button
                    onclick={() => prepare(skill.id, mode as NativeSkillMode)}
                    disabled={busy || !!pending || skill.mode === mode}
                  >
                    {modeName(mode as NativeSkillMode)}
                    {skill.name}
                  </Button>
                {/each}
              </div>
            {/if}
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
            <Button onclick={() => read(skill.id)} disabled={busy || !!pending}
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
  .mode-confirm {
    border: 1px solid #ff8a4c;
    padding: 1rem;
    margin-top: 1rem;
  }
  .mode-confirm :global(button) {
    min-height: 44px;
    margin: 0 0.5rem 0.5rem 0;
  }
  .mode-buttons :global(button) {
    min-height: 44px;
  }
  .mode-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
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
