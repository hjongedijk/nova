<script lang="ts">
  import { exportSettings, importSettings } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import Field from "#components/ui/Field.svelte";
  import { afterChange, fail, say } from "./state.svelte.ts";

  let files = $state<FileList | null>(null);
  let mode = $state<"merge" | "replace">("merge");

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
    try {
      const file = files?.[0];
      if (!file) return say("Kies eerst een bestand.", "bad");
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error("Dit bestand is geen geldige JSON.");
      }
      const result = await importSettings(data, mode);
      await afterChange(
        `${result.imported} vaardigheden geïmporteerd.${result.missingSecrets.length ? ` Vul de geheime headers opnieuw in bij: ${result.missingSecrets.map((item) => item.skill).join(", ")}.` : ""}`,
      );
    } catch (error) {
      fail(error);
    }
  }
</script>

<section>
  <h3>Exporteren</h3>
  <p class="hint">
    Een bestand met je vaardigheden, aanpassingen aan gereedschappen, eigen
    regels en snelle opdrachten. Geheime waarden zitten er bewust niet in; die
    vul je na het importeren opnieuw in.
  </p>
  <Button onclick={download}>Back-up downloaden</Button>
  <h3>Importeren</h3>
  <Field label="Back-upbestand" id="backupFile">
    <input
      id="backupFile"
      type="file"
      accept="application/json,.json"
      aria-label="Back-upbestand"
      bind:files
    />
  </Field>
  <Field label="Hoe" id="backupMode">
    <select id="backupMode" aria-label="Hoe importeren" bind:value={mode}>
      <option value="merge">Toevoegen aan wat er al is</option>
      <option value="replace">Alles vervangen</option>
    </select>
  </Field>
  <Button go onclick={upload}>Importeren</Button>
</section>
