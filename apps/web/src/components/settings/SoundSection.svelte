<script lang="ts">
  import { IS_IOS } from "#lib/stores/device.ts";
  import { speak } from "#lib/voice/speaker.ts";
  import { applyVolume, outputVolume, playback } from "#lib/voice/audio.ts";
  import { storage } from "#lib/util/storage.ts";
  import Badge from "#components/ui/Badge.svelte";
  import Button from "#components/ui/Button.svelte";
  import { setMicTest, stopMicTest, micTestRunning } from "./mic-test.ts";
  import { secureBase } from "#lib/stores/shell.svelte.ts";

  let volume = $state(Math.round(outputVolume() * 100));
  let level = $state(0);
  let testing = $state(false);
  let micNote = $state("");

  function setVolume(percent: number): void {
    volume = percent;
    storage.set("novaVolume", String(percent / 100));
    if (playback.current) applyVolume(playback.current);
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
    <Button onclick={() => void speak("Zo klink ik nu.")}
      >Laat de stem horen</Button
    >
    <Button onclick={micTest}
      >{testing ? "Stop de test" : "Test je microfoon"}</Button
    >
  </div>
  <div class="mic-meter" aria-hidden="true">
    <i style="width: {level}%"></i>
  </div>
  <p class="hint">{micNote}</p>
  <p class="hint">
    Het volume van je microfoon stel je in op het apparaat zelf: de
    spraakherkenning van de browser gebruikt de microfoon rechtstreeks. Windows:
    Instellingen, Systeem, Geluid, Invoer, Volume. Mac: Systeeminstellingen,
    Geluid, Invoer. Telefoons regelen dit zelf.
  </p>
</section>

<style>
  .field {
    margin: 0 0 14px;
  }

  .field > label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--mist);
  }

  .help {
    margin: 5px 0 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--dim);
  }
</style>
