<script lang="ts">
  import { onMount } from "svelte";
  import { IS_IOS } from "#lib/stores/device.ts";
  import { speak } from "#lib/voice/speaker.ts";
  import { applyVolume, outputVolume, playback } from "#lib/voice/audio.ts";
  import { storage } from "#lib/util/storage.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import Button from "#components/ui/Button.svelte";
  import { setMicTest, stopMicTest, micTestRunning } from "./mic-test.ts";
  import { secureBase } from "#lib/stores/shell.svelte.ts";
  import {
    TTS_VOICES,
    saveTtsProsody,
    saveTtsVoice,
    setServerDefaultVoice,
    ttsLocale,
    ttsProsody,
    ttsVoice,
  } from "#lib/voice/voice-preference.ts";
  import {
    pronunciationEntries,
    savePronunciationEntries,
    type PronunciationEntry,
  } from "#lib/voice/speech-filter.ts";
  import {
    saveWakeSensitivity,
    wakeSensitivity,
    type WakeSensitivity,
  } from "#lib/voice/wake-preference.ts";

  let volume = $state(Math.round(outputVolume() * 100));
  let level = $state(0);
  let testing = $state(false);
  let micNote = $state("");
  let pronunciations = $state<PronunciationEntry[]>(pronunciationEntries());
  let selectedVoice = $state(ttsVoice());
  let prosody = $state(ttsProsody());
  let sensitivity = $state<WakeSensitivity>(wakeSensitivity());
  let pronunciationTerm = $state("");
  let pronunciationSay = $state("");
  let pronunciationNote = $state("");
  let piperVoiceAvailable = $state(false);
  onMount(() => {
    fetch("/api/tts/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((health: { piperAvailable?: boolean; voice?: string } | null) => {
        piperVoiceAvailable = health?.piperAvailable === true;
        setServerDefaultVoice(health?.voice);
        selectedVoice = ttsVoice();
      })
      .catch(() => {});
  });
  const voiceExamples: Record<string, string> = {
    "de-DE": "Ich bin da. Womit möchtest du anfangen?",
    "en-US": "I'm here. What would you like to tackle first?",
    "en-GB": "I'm here. What would you like to tackle first?",
    "es-ES": "Estoy aquí. ¿Qué quieres hacer primero?",
    "fr-FR": "Je suis là. Par quoi voulez-vous commencer ?",
    "it-IT": "Ci sono. Da cosa vuoi iniziare?",
    "ja-JP": "ここにいます。何から始めましょうか？",
    "nl-BE": "Ik ben er. Wat wil je als eerste aanpakken?",
    "nl-NL": "Ik ben er. Wat wil je als eerste aanpakken?",
    "pt-BR": "Estou aqui. O que você quer fazer primeiro?",
  };
  const voiceGroups = [
    ["Nederlands", ["nl-NL", "nl-BE"]],
    ["Engels", ["en-US", "en-GB"]],
    ["Duits", ["de-DE"]],
    ["Frans", ["fr-FR"]],
    ["Spaans", ["es-ES"]],
    ["Italiaans", ["it-IT"]],
    ["Portugees", ["pt-BR"]],
    ["Japans", ["ja-JP"]],
  ] as const;
  let voiceExample = $derived(
    voiceExamples[ttsLocale()] ?? voiceExamples["nl-NL"]!,
  );

  function setVolume(percent: number, recordChange = false): void {
    volume = percent;
    storage.set(
      "novaVolume",
      String(percent / 100),
      recordChange ? "volume" : undefined,
    );
    if (playback.current) applyVolume(playback.current);
  }

  function chooseVoice(value: string): void {
    selectedVoice = saveTtsVoice(value);
  }

  function adjustProsody(
    field: "rate" | "pitch",
    value: number,
    recordChange = false,
  ): void {
    prosody = saveTtsProsody(
      field === "rate" ? value : prosody.rate,
      field === "pitch" ? value : prosody.pitch,
      recordChange,
    );
  }

  function chooseWakeSensitivity(value: string): void {
    if (value === "low" || value === "normal" || value === "high")
      sensitivity = saveWakeSensitivity(value);
  }

  function addPronunciation(): void {
    const term = pronunciationTerm.trim();
    const say = pronunciationSay.trim();
    if (!term || !say || term.length > 80 || say.length > 120) {
      pronunciationNote = "Vul een woord in en hoe NOVA het moet uitspreken.";
      return;
    }
    if (pronunciations.length >= 100) {
      pronunciationNote = "De uitspraaklijst bevat maximaal 100 woorden.";
      return;
    }
    pronunciations = [
      ...pronunciations.filter(
        (entry) => entry.term.toLocaleLowerCase() !== term.toLocaleLowerCase(),
      ),
      { term, say },
    ];
    savePronunciationEntries(pronunciations);
    pronunciationTerm = "";
    pronunciationSay = "";
    pronunciationNote = "Uitspraak opgeslagen op dit apparaat.";
  }

  function removePronunciation(term: string): void {
    pronunciations = pronunciations.filter((entry) => entry.term !== term);
    savePronunciationEntries(pronunciations);
    pronunciationNote = "Uitspraak verwijderd.";
  }

  async function micTest(): Promise<void> {
    if (micTestRunning()) return stopMicTest();
    if (!navigator.mediaDevices?.getUserMedia) {
      micNote = window.isSecureContext
        ? "Deze browser laat de microfoon niet testen."
        : `Open NOVA via ${secureBase()}; zonder beveiligde verbinding mag de microfoon niet.`;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const node = context.createAnalyser();
      node.fftSize = 512;
      context.createMediaStreamSource(stream).connect(node);
      const data = new Uint8Array(node.fftSize);
      let peak = 0;
      let frame = 0;
      const draw = () => {
        node.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        const now = Math.min(1, Math.sqrt(sum / data.length) * 4);
        peak = Math.max(peak, now);
        level = Math.round(now * 100);
        frame = requestAnimationFrame(draw);
      };
      draw();
      testing = true;
      micNote =
        "Praat gewoon. Komt de balk bij normaal praten tot ongeveer de helft, dan staat je microfoon goed.";
      const timer = setTimeout(stopMicTest, 15000);
      setMicTest(() => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
        level = 0;
        testing = false;
        micNote =
          peak < 0.15
            ? "Ik hoorde je nauwelijks. Zet het invoervolume van je microfoon hoger (zie hieronder)."
            : peak > 0.95
              ? "Je microfoon staat erg hard; dat kan vervormen. Zet het invoervolume iets lager."
              : "Je microfoon klinkt goed.";
      });
    } catch {
      micNote =
        "De microfoon is geblokkeerd of niet gevonden. Sta hem toe voor deze pagina.";
    }
  }
</script>

<section>
  <div class="field">
    <label for="ttsVoice">Stem van NOVA</label>
    <select
      id="ttsVoice"
      value={selectedVoice}
      onchange={(event) => chooseVoice(event.currentTarget.value)}
    >
      {#each voiceGroups as [language, locales] (language)}
        <optgroup label={language}>
          {#each TTS_VOICES.filter( (voice) => (locales as readonly string[]).includes(voice.id.slice(0, 5)) ) as voice (voice.id)}
            <option value={voice.id}>{voice.label}</option>
          {/each}
        </optgroup>
      {/each}
      {#if piperVoiceAvailable}
        <optgroup label="Lokale stemmen">
          <option value="jarvis-en-GB-piper">Engels (lokale Piper-stem)</option>
        </optgroup>
      {/if}
    </select>
    <p class="help">
      Deze keuze geldt voor de helper, wallpaper en PWA in deze browser.
    </p>
  </div>
  <div class="field">
    <label for="volumeSlider">Volume van NOVA's stem</label>
    <div class="set-toolbar">
      <input
        type="range"
        min="0"
        max="100"
        step="5"
        id="volumeSlider"
        aria-label="Volume van NOVA"
        value={volume}
        oninput={(event) => setVolume(Number(event.currentTarget.value))}
        onchange={(event) => setVolume(Number(event.currentTarget.value), true)}
      />
      <Badge text="{volume}%" />
    </div>
    <p class="help">
      {IS_IOS
        ? "Op een iPhone regel je het volume ook met de knoppen van je telefoon."
        : "Geldt voor de stem en het geluidje als NOVA gaat luisteren, op dit apparaat."}
    </p>
  </div>
  <div class="set-toolbar">
    <Button onclick={() => void speak(voiceExample)}>Laat de stem horen</Button>
    <Button onclick={micTest}
      >{testing ? "Stop de test" : "Test je microfoon"}</Button
    >
  </div>
  <p class="voice-example" aria-label="Voorbeeldzin van NOVA">
    “{voiceExample}”
  </p>
  <div class="mic-meter" aria-hidden="true">
    <i style="width: {level}%"></i>
  </div>
  <p class="hint">{micNote}</p>
  <Disclosure
    kind="advanced"
    title="Geavanceerd"
    hint="Spreeksnelheid, toonhoogte, wake word en uitspraaklijst"
  >
    <div class="field">
      <label for="ttsRate"
        >Spreeksnelheid ({prosody.rate > 0 ? "+" : ""}{prosody.rate}%)</label
      >
      <input
        id="ttsRate"
        type="range"
        min="-10"
        max="10"
        step="1"
        value={prosody.rate}
        oninput={(event) =>
          adjustProsody("rate", Number(event.currentTarget.value))}
        onchange={(event) =>
          adjustProsody("rate", Number(event.currentTarget.value), true)}
      />
    </div>
    <div class="field">
      <label for="ttsPitch"
        >Toonhoogte ({prosody.pitch > 0 ? "+" : ""}{prosody.pitch} Hz)</label
      >
      <input
        id="ttsPitch"
        type="range"
        min="-5"
        max="5"
        step="1"
        value={prosody.pitch}
        oninput={(event) =>
          adjustProsody("pitch", Number(event.currentTarget.value))}
        onchange={(event) =>
          adjustProsody("pitch", Number(event.currentTarget.value), true)}
      />
      <p class="help">
        Kleine verschillen tussen zinnen maken de stem minder vlak.
      </p>
    </div>
    <div class="field">
      <label for="wakeSensitivity">Gevoeligheid van het wake word</label>
      <select
        id="wakeSensitivity"
        value={sensitivity}
        onchange={(event) => chooseWakeSensitivity(event.currentTarget.value)}
      >
        <option value="low">Laag — alleen “Hey NOVA”</option>
        <option value="normal">Normaal — “NOVA” of “Hey NOVA”</option>
        <option value="high">Hoog — ook alternatieve uitspraken</option>
      </select>
      <p class="help">Deze keuze blijft alleen in deze browser.</p>
    </div>
    <p class="hint">
      Het volume van je microfoon stel je in op het apparaat zelf: de
      spraakherkenning van de browser gebruikt de microfoon rechtstreeks.
      Windows: Instellingen, Systeem, Geluid, Invoer, Volume. Mac:
      Systeeminstellingen, Geluid, Invoer. Telefoons regelen dit zelf.
    </p>
    <div class="pronunciations">
      <h3>Uitspraaklijst</h3>
      <p class="help">
        Geef namen of apparaten een eigen uitspraak. Deze lijst blijft alleen in
        deze browser.
      </p>
      <label for="pronunciationTerm">Woord of naam</label>
      <input
        id="pronunciationTerm"
        bind:value={pronunciationTerm}
        maxlength="80"
        autocomplete="off"
      />
      <label for="pronunciationSay">Spreek uit als</label>
      <input
        id="pronunciationSay"
        bind:value={pronunciationSay}
        maxlength="120"
        autocomplete="off"
      />
      <Button onclick={addPronunciation}>Uitspraak toevoegen</Button>
      {#if pronunciationNote}<p role="status">{pronunciationNote}</p>{/if}
      {#if pronunciations.length}
        <ul>
          {#each pronunciations as entry (entry.term)}
            <li>
              <span>{entry.term} → {entry.say}</span>
              <Button onclick={() => removePronunciation(entry.term)}
                >Verwijderen</Button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </Disclosure>
</section>
