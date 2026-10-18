<script lang="ts">
  import { exportSettings, importSettings } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import { afterChange, fail, say } from "./state.svelte.ts";
  import Disclosure from "./ui/Disclosure.svelte";

  let files = $state<FileList | null>(null);
  let mode = $state<"merge" | "replace">("merge");
  let busy = $state(false);

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
        return say("De back-up is te groot (maximaal 1 MB).", "bad");
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        return say("Dit bestand is geen geldige JSON.", "bad");
      }
      const result = await importSettings(data, mode);
      if (!result.ok) return say(result.error, "bad");
      const connectionMessage =
        result.changedConnections === 1
          ? "1 servicekoppeling gewijzigd."
          : `${result.changedConnections} servicekoppelingen gewijzigd.`;
      await afterChange(
        `${result.imported} vaardigheden, ${result.importedLists ?? 0} lijsten en ${result.importedFlows ?? 0} Node-RED-flows geïmporteerd; ${connectionMessage}${result.missingSecrets.length ? ` Geheime headers van vaardigheden die niet overeenkomen moet je opnieuw invullen bij: ${result.missingSecrets.map((item) => item.skill).join(", ")}.` : ""}${result.changedConnections ? " Herstart de betrokken services voordat je ze gebruikt." : ""}${result.auditWarning ? ` ${result.auditWarning}` : ""}`,
      );
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h2>Back-up maken en terugzetten</h2>
  <p class="hint">
    Bewaar je instellingen in één bestand, zodat je ze later of op een andere
    installatie kunt terugzetten.
  </p>
  <h3>Back-up maken</h3>
  <Disclosure kind="more" title="Meer uitleg" hint="Wat er wel en niet in zit">
    <p class="hint">
      Een bestand met je vaardigheden, aanpassingen aan gereedschappen, eigen
      regels, snelle opdrachten, helperinstellingen en je boodschappen- en
      takenlijsten. Ook serviceadressen en veilige opties worden opgenomen.
      Actieve timers en meldingen worden niet overgezet. Servicegeheimen blijven
      lokaal op de doelinstallatie en worden nooit geëxporteerd of vervangen.
      OmniRoute-provideraccounts, API-sleutels en routebeleid zijn geen
      onderdeel van dit bestand. Node-RED-flowlogica wordt meegenomen als lokale
      beheertoegang is ingesteld; credentials worden altijd weggelaten.
    </p>
  </Disclosure>
  <Button go onclick={download}>Back-up downloaden</Button>
  <h3>Back-up terugzetten</h3>
  <Field label="Back-upbestand" id="backupFile">
    <input
      disabled={busy}
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
      disabled={busy}
    >
      <option value="merge">Toevoegen aan wat er al is</option>
      <option value="replace">Alles vervangen</option>
    </select>
  </Field>
  <p class="ds-hint">
    Kies een back-upbestand (maximaal 1 MB). De import wordt meteen toegepast.
  </p>
  <Disclosure kind="more" title="Meer uitleg" hint="Wat wordt er teruggezet?">
    <p>
      Maximaal 1 MB. NOVA controleert het bestand vóór de import.
      Serviceadressen veranderen meteen en vereisen daarna een herstart. Geheime
      servicewaarden en permanente toestemmingen zitten niet in de back-up;
      bestaande servicegeheimen blijven op deze installatie staan. Flowimport
      vereist Node-RED-beheertoegang; credentials worden nooit meegenomen.
      Actieve timers en meldingen blijven buiten de back-up.
    </p>
  </Disclosure>
  <Button go onclick={upload} disabled={busy}>Back-up terugzetten</Button>
</section>
