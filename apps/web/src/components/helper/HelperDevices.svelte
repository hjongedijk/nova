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
  import {
    discoverInputDevices,
    selectedInputDevice,
    setSelectedInputDevice,
    supportsSpeechInputSelection,
  } from "#lib/voice/input-device.ts";
  import { storage } from "#lib/util/storage.ts";
  let hotkeys = $state<Record<string, string>>({
    open: "Ctrl+Alt+N",
    speak: "Ctrl+Alt+Space",
    mute: "Ctrl+Alt+M",
    desktop: "Ctrl+Alt+D",
  });
  let note = $state("");
  let outputs: MediaDeviceInfo[] = $state([]);
  let inputs: MediaDeviceInfo[] = $state([]);
  let output = $state("");
  let input = $state("");
  let inputSupported = $state(false);
  const outputDeviceKey = "novaAudioOutput";
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
      const saved = storage.get(outputDeviceKey, "");
      if (saved && outputs.some((device) => device.deviceId === saved)) {
        output = saved;
        await setOutput();
      } else if (saved) {
        output = "";
        storage.set(outputDeviceKey, "");
        note =
          "Opgeslagen uitvoerapparaat niet gevonden; standaarduitvoer wordt gebruikt.";
      }
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
      storage.set(outputDeviceKey, output);
      note = output
        ? "Uitvoerapparaat gekozen en op dit apparaat bewaard."
        : "Standaarduitvoer gekozen.";
    } catch (error) {
      note = (error as Error).message;
      output = "";
      storage.set(outputDeviceKey, "");
    }
  }
  async function findInputs() {
    try {
      inputs = await discoverInputDevices();
      if (input && !inputs.some((device) => device.deviceId === input)) {
        input = "";
        setSelectedInputDevice("");
        note =
          "Opgeslagen microfoon niet gevonden; de standaardmicrofoon wordt weer gebruikt.";
      } else {
        note = inputs.length
          ? "Microfoons gevonden. Je keuze geldt voor spreken en Hey NOVA."
          : "Geen microfoon gevonden.";
      }
    } catch {
      note = "Geef NOVA microfoontoegang om invoerapparaten te tonen.";
    }
  }
  function setInput() {
    setSelectedInputDevice(input);
    note = input
      ? "Microfoon gekozen voor spreken en Hey NOVA."
      : "Standaardmicrofoon gekozen.";
  }
  onMount(() => {
    inputSupported = supportsSpeechInputSelection();
    input = selectedInputDevice();
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
  {#if inputSupported}
    <p>
      De gekozen microfoon geldt voor spreken en Hey NOVA. NOVA stopt de opname
      zodra luisteren eindigt.
    </p>
    <button class="hp-button" type="button" onclick={findInputs}
      >Microfoons zoeken</button
    >
    <label
      >Invoerapparaat<select bind:value={input} onchange={setInput}
        ><option value="">Standaardmicrofoon</option
        >{#if input && !inputs.some((device) => device.deviceId === input)}<option
            value={input}>Opgeslagen microfoon (nog niet gecontroleerd)</option
          >{/if}{#each inputs as device (device.deviceId)}<option
            value={device.deviceId}>{device.label || "Microfoon"}</option
          >{/each}</select
      ></label
    >
  {:else}
    <p>
      Deze browser kan geen aparte invoermicrofoon aan spraakherkenning
      koppelen. Kies de microfoon in Windows.
    </p>
    <a href="ms-settings:sound" class="hp-button">Windows-geluid</a>
  {/if}
  <label
    >Uitvoerapparaat<select bind:value={output} onchange={() => setOutput()}
      ><option value="">Standaard</option
      >{#each outputs as device (device.deviceId)}<option
          value={device.deviceId}>{device.label || "Audio-uitvoer"}</option
        >{/each}</select
    ></label
  >
</details>
{#if note}<p role="status">{note}</p>{/if}

{#if message.text}<p role="status">{message.text}</p>{/if}
