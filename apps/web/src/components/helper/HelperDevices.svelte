<script lang="ts">
  import { onMount } from "svelte";
  import {
    getHelperHotkeys,
    saveHelperHotkeys,
    setPin,
  } from "#lib/api/settings.ts";
  import { message } from "#components/settings/state.svelte.ts";
  import DevicesSection from "#components/settings/DevicesSection.svelte";
  import SoundSection from "#components/settings/SoundSection.svelte";
  import { audioContext, ttsElement } from "#lib/voice/audio.ts";
  let hotkeys = $state<Record<string, string>>({
    open: "Ctrl+Alt+N",
    speak: "Ctrl+Alt+Space",
    mute: "Ctrl+Alt+M",
    desktop: "Ctrl+Alt+D",
  });
  let note = $state("");
  let outputs: MediaDeviceInfo[] = $state([]);
  let output = $state("");
  async function save() {
    try {
      const result = await saveHelperHotkeys(hotkeys);
      note = result.ok
        ? result.preferences?.warnings.join(" · ") || "Sneltoetsen opgeslagen."
        : result.error || "Opslaan mislukt.";
    } catch (error) {
      note = (error as Error).message;
    }
  }
  async function devices() {
    try {
      outputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "audiooutput",
      );
    } catch {
      note = "Deze browser geeft geen uitvoerapparaten vrij.";
    }
  }
  async function setOutput() {
    try {
      const context = audioContext() as AudioContext & {
        setSinkId?: (id: string) => Promise<void>;
      };
      const audio = ttsElement() as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (context.setSinkId) await context.setSinkId(output);
      else if (audio.setSinkId && !ttsElement()._source)
        await audio.setSinkId(output);
      else throw new Error("Kies je uitvoer via Windows-geluidsinstellingen.");
      note = "Uitvoerapparaat gekozen voor deze sessie.";
    } catch (error) {
      note = (error as Error).message;
    }
  }
  onMount(() => {
    void getHelperHotkeys()
      .then((result) => {
        if (result.preferences) {
          hotkeys = result.preferences.hotkeys;
          note = result.preferences.warnings.join(" · ");
        }
      })
      .catch(() => undefined);
    void devices();
  });
</script>

<label
  >Beheer-PIN <input
    class="hp-input"
    type="password"
    aria-label="Beheer-PIN"
    autocomplete="off"
    oninput={(event) => setPin(event.currentTarget.value)}
  /></label
>
<details><summary>Windows, modus en scherm</summary><DevicesSection /></details>
<details>
  <summary>Sneltoetsen</summary>
  {#each [{ id: "open", label: "Openen" }, { id: "speak", label: "Spreken" }, { id: "mute", label: "Dempen" }, { id: "desktop", label: "Bureaublad" }] as key (key.id)}<label
      >{key.label}<input
        class="hp-input"
        bind:value={hotkeys[key.id]}
        aria-label={`Sneltoets ${key.label}`}
      /></label
    >{/each}
  <button class="hp-button" onclick={save}>Sneltoetsen opslaan</button>
</details>
<details>
  <summary>Microfoon en stem</summary><SoundSection />
  <p>
    Spraakherkenning gebruikt de standaardmicrofoon van je browser. Kies die in
    Windows.
  </p>
  <a href="ms-settings:sound" class="hp-button">Windows-geluid</a>
  <label
    >Uitvoerapparaat<select bind:value={output} onchange={setOutput}
      ><option value="">Standaard</option
      >{#each outputs as device (device.deviceId)}<option
          value={device.deviceId}>{device.label || "Audio-uitvoer"}</option
        >{/each}</select
    ></label
  >
</details>
{#if note}<p role="status">{note}</p>{/if}

{#if message.text}<p role="status">{message.text}</p>{/if}
