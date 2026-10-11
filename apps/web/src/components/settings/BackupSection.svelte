<script lang="ts">
  import { onDestroy } from "svelte";
  import type { SettingsImportPrepared } from "@nova/contracts";
  import {
    exportSettings,
    prepareSettingsImport,
    importSettings,
  } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import { afterChange, fail, say } from "./state.svelte.ts";

  let files = $state<FileList | null>(null);
  let mode = $state<"merge" | "replace">("merge");
  let busy = $state(false);
  let acknowledged = $state(false);
  let pending = $state<SettingsImportPrepared | null>(null);
  let expired = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));

  async function download(): Promise<void> {
    try {
      const data = await exportSettings();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      link.download = "nova-instellingen.json";
      link.click();
      URL.revokeObjectURL(link.href);
      say("De back-up is gedownload.", "ok");
    } catch (error) {
      fail(error);
    }
  }

  async function upload(): Promise<void> {
    busy = true;
    try {
      const file = files?.[0];
      if (!file) return say("Kies eerst een bestand.", "bad");
      if (file.size > 1_000_000)
        throw new Error("De back-up is te groot (maximaal 1 MB).");
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error("Dit bestand is geen geldige JSON.");
      }
      pending = await prepareSettingsImport(data, mode);
      expired = false;
      timer = setTimeout(
        () => {
          expired = true;
        },
        Math.max(0, pending.action.expiresAt - Date.now()),
      );
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }
  async function confirm(approve: boolean): Promise<void> {
    const action = pending?.action;
    if (!action) return;
    busy = true;
    try {
      const result = await importSettings(
        action.sessionId,
        action.confirmationId,
        approve,
      );
      if (!result.ok) return say(result.error, "bad");
      if (!approve) return say("Import geannuleerd.", "ok");
      const connectionMessage =
        result.changedConnections === 1
          ? "1 servicekoppeling gewijzigd."
          : `${result.changedConnections} servicekoppelingen gewijzigd.`;
      await afterChange(
        `${result.imported} vaardigheden, ${result.importedLists ?? 0} lijsten en ${result.importedFlows ?? 0} Node-RED-flows geïmporteerd; ${connectionMessage}${result.missingSecrets.length ? ` Geheime headers van vaardigheden die niet overeenkomen moet je opnieuw invullen bij: ${result.missingSecrets.map((item) => item.skill).join(", ")}.` : ""}${result.changedConnections ? " Herstart de betrokken services voordat je ze gebruikt." : ""}${result.auditWarning ? ` ${result.auditWarning}` : ""}`,
      );
    } catch {
      say(
        "Uitkomst onbekend. Controleer je instellingen voordat je opnieuw importeert.",
        "bad",
      );
    } finally {
      clearTimeout(timer);
      pending = null;
      acknowledged = false;
      busy = false;
    }
  }
</script>

<section>
  <h3>Exporteren</h3>
  <p class="hint">
    Een bestand met je vaardigheden, aanpassingen aan gereedschappen, eigen
    regels, snelle opdrachten, helperinstellingen en je boodschappen- en
    takenlijsten. Ook serviceadressen en veilige opties worden opgenomen.
    Actieve timers en meldingen worden niet overgezet. Servicegeheimen blijven
    lokaal op de doelinstallatie en worden nooit geëxporteerd of vervangen.
    OmniRoute-provideraccounts, API-sleutels en routebeleid zijn geen onderdeel
    van dit bestand. Node-RED-flowlogica wordt meegenomen als lokale
    beheertoegang is ingesteld; credentials worden altijd weggelaten.
  </p>
  <Button onclick={download}>Back-up downloaden</Button>
  <h3>Importeren</h3>
  <Field label="Back-upbestand" id="backupFile">
    <input
      disabled={busy || !!pending}
      onchange={() => {
        acknowledged = false;
      }}
      id="backupFile"
      type="file"
      accept="application/json,.json"
      aria-label="Back-upbestand"
      bind:files
    />
  </Field>
  <Field label="Hoe" id="backupMode">
    <select
      id="backupMode"
      aria-label="Hoe importeren"
      bind:value={mode}
      disabled={busy || !!pending}
      onchange={() => {
        acknowledged = false;
      }}
    >
      <option value="merge">Toevoegen aan wat er al is</option>
      <option value="replace">Alles vervangen</option>
    </select>
  </Field>
  <p>
    Maximaal 1 MB. NOVA controleert het bestand vóór de import. Serviceadressen
    veranderen pas na bevestiging en vereisen daarna een herstart. Geheime
    servicewaarden en permanente toestemmingen zitten niet in de back-up;
    bestaande servicegeheimen blijven op deze installatie staan. Flowimport
    vereist Node-RED-beheertoegang; credentials worden nooit meegenomen. Actieve
    timers en meldingen blijven buiten de back-up.
  </p>
  {#if pending}
    <div
      class="import-review"
      role="group"
      aria-label="Back-upimport controleren"
    >
      <h3>Controle vóór import</h3>
      <p>
        {pending.summary.mode === "replace" ? "Vervangen" : "Samenvoegen"}: {pending
          .summary.incomingSkills} inkomende vaardigheden, {pending.summary
          .incomingWidgets} inkomende panelen.
      </p>
      <p>
        Na import: {pending.summary.totalSkills} vaardigheden en {pending
          .summary.totalWidgets} panelen en {pending.summary.totalLists} lijsten.
        {pending.summary.replacedSkills} vaardigheden worden vervangen; {pending
          .summary.removedSkills} vaardigheden en {pending.summary
          .removedWidgets} panelen en {pending.summary.removedLists} lijsten worden
        verwijderd.
      </p>
      <ul>
        <li>
          Eigen regels: {pending.summary.personaChanged
            ? "wijzigen"
            : "blijven gelijk"}
        </li>
        <li>
          Gespreksstijl: {pending.summary.personaStyleChanged
            ? "wijzigen"
            : "blijft gelijk"}
        </li>
        <li>
          NOVA-profiel: {pending.summary.personaProfileChanged
            ? "wijzigen"
            : "blijft gelijk"}
        </li>
        <li>
          Gezinsprofielen: {pending.summary.householdProfilesChanged
            ? "wijzigen"
            : "blijven gelijk"}
        </li>
        <li>
          Snelle opdrachten: {pending.summary.quickActionsChanged
            ? "wijzigen"
            : "blijven gelijk"}
        </li>
        <li>
          Lijsten: {pending.summary.listsChanged
            ? "wijzigen"
            : "blijven gelijk"}
          ({pending.summary.incomingLists} inkomend)
        </li>
        <li>
          Gereedschapsinstellingen: {pending.summary.toolOverridesChanged
            ? "wijzigen"
            : "blijven gelijk"}
        </li>
        <li>
          Zijbalkindeling: {pending.summary.sidebarChanged
            ? "wijzigt"
            : "blijft gelijk"}
        </li>
        <li>
          Gewenste schermmodus: {pending.summary.helperChanged
            ? "wijzigt"
            : "blijft gelijk"}
        </li>
        <li>
          Helperinstellingen: {pending.summary.helperPreferencesChanged
            ? "wijzigen"
            : "blijven gelijk"}
        </li>
        <li>
          Modelrollen: {pending.summary.modelRolesChanged
            ? "wijzigen"
            : "blijven gelijk"}
        </li>
        <li>
          Node-RED-flows: {pending.summary.nodeRedFlowsChanged
            ? `${pending.summary.incomingFlows} inkomend; ${pending.summary.totalFlows} na import; ${pending.summary.removedFlows} verwijderd`
            : "blijven gelijk"}
        </li>
        <li>
          Servicekoppelingen: {pending.summary.changedConnections
            ? `${pending.summary.changedConnections} wijzigen`
            : "blijven gelijk"}
        </li>
      </ul>
      {#if pending.summary.connectionChanges.length}
        <h4>Controleer adressen en opties</h4>
        {#each pending.summary.connectionChanges as change (change.service)}
          <details>
            <summary>{change.service}</summary>
            <p>Huidig: {JSON.stringify(change.before)}</p>
            <p>Na import: {JSON.stringify(change.after)}</p>
          </details>
        {/each}
        <p>
          Bestaande geheimen blijven op deze server staan. Als je een adres
          wijzigt, kunnen dezelfde credentials na herstart naar die bestemming
          worden gestuurd.
        </p>
      {/if}
      <p>
        Geïmporteerde webhooks kunnen actief worden volgens dit bestand.
        Controleer zelf hun doelen en acties.
      </p>
      {#if pending.summary.helperChanged}<p>
          De schermmodus wordt alleen bewaard. Pas die op de pc toe via
          Apparaten.
        </p>{/if}
      {#if pending.summary.missingSecrets.length}
        <p>Geheime headers moet je opnieuw invullen:</p>
        <ul>
          {#each pending.summary.missingSecrets as item, index (index)}<li>
              {item.skill}: {item.headers.join(", ")}
            </li>{/each}
        </ul>
      {/if}
      <p>
        Risicovolle wijziging. Deze toestemming is 60 seconden geldig en één
        keer bruikbaar. Instellingen die intussen wijzigen maken deze import
        ongeldig.
      </p>
      {#if expired}<p role="status">
          Toestemming verlopen. Annuleer en controleer het bestand opnieuw.
        </p>{/if}
      <Button go onclick={() => confirm(true)} disabled={busy || expired}
        >Bevestig back-upimport</Button
      >
      <Button onclick={() => confirm(false)} disabled={busy}
        >Annuleer back-upimport</Button
      >
    </div>
  {:else}
    <label class="import-ack"
      ><input type="checkbox" bind:checked={acknowledged} disabled={busy} />Ik
      wil deze instellingen en vaardigheden importeren en controleer eerst de
      wijzigingen.</label
    >
    <Button go onclick={upload} disabled={busy || !acknowledged}
      >Back-up controleren</Button
    >
  {/if}
</section>

<style>
  .import-review {
    margin-block: 1rem;
    padding: 1rem;
    border: 1px solid #ff8a33;
    overflow-wrap: anywhere;
  }
  .import-ack {
    display: flex;
    gap: 0.5rem;
    margin-block: 1rem;
  }
  :global(.import-review button) {
    min-height: 44px;
    margin: 0.25rem 0.5rem 0.25rem 0;
  }
</style>
