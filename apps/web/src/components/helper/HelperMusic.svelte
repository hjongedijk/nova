<script lang="ts">
  import { onMount } from "svelte";
  import type { HaEntity } from "@nova/contracts";
  import { getJson } from "#lib/api/client.ts";
  import { executeAction } from "#lib/api/admin.ts";
  import { storage } from "#lib/util/storage.ts";

  type Player = { id: string; name: string; state?: string };
  type Playback = { state: string; attributes: Record<string, unknown> };
  let players = $state<Player[]>([]);
  let selected = $state("");
  let playback = $state<Playback>({ state: "unknown", attributes: {} });
  let busy = $state(false);
  let loading = $state(true);
  let error = $state("");
  let note = $state("");
  let now = $state(Date.now());
  let imageFailed = $state(false);
  let stopped = false;
  let revision = 0;
  const session = `helper-media-${crypto.randomUUID()}`;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const attributes = $derived(playback.attributes);
  const pc = $derived(selected === "pc");
  const playing = $derived(playback.state === "playing");
  const title = $derived(
    pc
      ? "Actieve pc-speler"
      : text(attributes.media_title) ||
          (playing ? "Er wordt afgespeeld" : "Kies iets om af te spelen"),
  );
  const artist = $derived(
    pc
      ? "Spotify, Chrome of een andere Windows-speler"
      : text(attributes.media_artist) ||
          text(attributes.media_album_name) ||
          players.find((p) => p.id === selected)?.name ||
          "",
  );
  const duration = $derived(number(attributes.media_duration));
  const position = $derived.by(() => {
    const updated = Date.parse(text(attributes.media_position_updated_at));
    const elapsed =
      playing && Number.isFinite(updated)
        ? Math.max(0, (now - updated) / 1000)
        : 0;
    return Math.min(
      duration || Infinity,
      Math.max(0, number(attributes.media_position) + elapsed),
    );
  });
  const volume = $derived(Math.round(number(attributes.volume_level) * 100));
  const cover = $derived(
    /^https:\/\/(?:i|mosaic)\.scdn\.co\/image\/[a-z0-9]+$/i.test(
      text(attributes.entity_picture),
    )
      ? text(attributes.entity_picture)
      : "",
  );
  $effect(() => {
    void cover;
    imageFailed = false;
  });
  const time = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

  async function refresh(target = selected) {
    if (!target || stopped) return;
    const attempt = ++revision;
    if (target === "pc") {
      playback = { state: "unknown", attributes: {} };
      return;
    }
    try {
      const result = await executeAction(session, "ha_get_state", {
        entity_id: target,
      });
      if (stopped || attempt !== revision || target !== selected) return;
      if (!result.ok)
        throw new Error(result.error || "De speler is niet bereikbaar.");
      const value = result.result as Playback | undefined;
      if (!value || typeof value.state !== "string" || !value.attributes)
        throw new Error("Geen afspeelgegevens ontvangen.");
      playback = value;
      error = "";
    } catch (cause) {
      if (!stopped && attempt === revision) {
        playback = { ...playback, state: "unknown" };
        error =
          cause instanceof Error ? cause.message : "Speler ophalen mislukt.";
      }
    }
  }
  $effect(() => {
    const target = selected;
    if (target) {
      playback = { state: "unknown", attributes: {} };
      note = "";
      error = "";
      storage.set("nova.helper.media.target", target);
      void refresh(target);
    }
  });
  onMount(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = setInterval(() => {
      now = Date.now();
    }, 1000);
    async function load() {
      const [home, windows] = await Promise.allSettled([
        getJson<{ entities: HaEntity[] }>("/entities?domain=media_player", {
          signal: controller.signal,
        }),
        getJson<{ available: boolean }>("/settings/windows/status", {
          signal: controller.signal,
        }),
      ]);
      if (stopped) return;
      const found =
        home.status === "fulfilled"
          ? home.value.entities
              .filter((p) => p.entity_id.startsWith("media_player."))
              .map((p) => ({
                id: p.entity_id,
                name: p.friendly_name || p.entity_id,
                state: p.state,
              }))
          : [];
      players =
        windows.status === "fulfilled" && windows.value.available
          ? [...found, { id: "pc", name: "Deze pc · Windows-speler" }]
          : found;
      const saved = storage.get("nova.helper.media.target", "");
      selected = players.some((p) => p.id === saved)
        ? saved
        : players.find((p) => p.state === "playing")?.id ||
          players[0]?.id ||
          "";
      loading = false;
      async function poll() {
        if (!document.hidden && !busy) await refresh();
        if (!stopped) timer = setTimeout(() => void poll(), 5000);
      }
      timer = setTimeout(() => void poll(), 5000);
    }
    void load();
    return () => {
      stopped = true;
      revision++;
      controller.abort();
      clearInterval(tick);
      clearTimeout(timer);
    };
  });

  async function control(
    action: "toggle" | "next" | "previous" | "volume" | "mute",
    value?: number,
  ) {
    if (busy || !selected) return;
    busy = true;
    error = "";
    note = "";
    const target = selected;
    try {
      const tool = pc
        ? "desktop_media_key"
        : action === "toggle"
          ? playing
            ? "media_pause"
            : "media_play"
          : action === "volume"
            ? "media_set_volume"
            : action === "mute"
              ? "media_mute"
              : `media_${action}`;
      const args = pc
        ? { action }
        : {
            entity_id: target,
            ...(action === "volume"
              ? { volume_level: (value ?? 0) / 100 }
              : {}),
            ...(action === "mute"
              ? { is_volume_muted: attributes.is_volume_muted !== true }
              : {}),
          };
      const result = await executeAction(session, tool, args);
      if (!result.ok) throw new Error(result.error || "Bedienen mislukt.");
      if (!stopped) {
        if (pc)
          note =
            "Mediatoets verstuurd. Windows geeft hier geen titel of afspeelstatus door.";
        else await refresh(target);
      }
    } catch (cause) {
      if (!stopped)
        error = cause instanceof Error ? cause.message : "Bedienen mislukt.";
    } finally {
      if (!stopped) busy = false;
    }
  }
</script>

<section class="music" aria-label="Muziekspeler">
  {#if loading}<p class="empty">Je spelers ophalen…</p>
  {:else if !players.length}<div class="empty">
      <strong>Je muziek, dichtbij.</strong>
      <p>
        Verbind Spotify, Sonos of een Cast-speler via Home Assistant, of zet je
        gekoppelde pc aan.
      </p>
    </div>
  {:else}
    <label class="source"
      ><span>Muziekbron</span><select
        aria-label="Muziekbron"
        bind:value={selected}
        disabled={busy}
        >{#each players as player (player.id)}<option value={player.id}
            >{player.name}</option
          >{/each}</select
      ></label
    >
    <div class="track">
      <div class="art" class:playing aria-hidden="true">
        {#if cover && !imageFailed}<img
            src={cover}
            alt=""
            referrerpolicy="no-referrer"
            onerror={() => (imageFailed = true)}
          />{:else}<div class="record"><span>✦</span></div>{/if}
      </div>
      <div class="info">
        <small
          >{pc
            ? "Windows-mediabediening"
            : playing
              ? "Nu aan het spelen"
              : playback.state === "paused"
                ? "Gepauzeerd"
                : "Je muziek"}</small
        >
        <h2>{title}</h2>
        <p>{artist}</p>
        {#if duration > 0}<div class="timeline">
            <progress
              max={duration}
              value={position}
              aria-label="Voortgang nummer"
            ></progress><span>{time(position)}</span><span
              >{time(duration)}</span
            >
          </div>{/if}
        <div class="transport">
          <button
            type="button"
            disabled={busy}
            aria-label="Vorig nummer"
            onclick={() => control("previous")}
            ><svg viewBox="0 0 24 24"><path d="M6 5v14m13-14L8 12l11 7Z" /></svg
            ></button
          ><button
            class="play"
            type="button"
            disabled={busy}
            aria-label={pc
              ? "Afspelen of pauzeren op pc"
              : playing
                ? "Pauzeren"
                : "Afspelen"}
            onclick={() => control("toggle")}
            ><svg viewBox="0 0 24 24"
              >{#if playing}<path d="M8 6v12M16 6v12" />{:else}<path
                  d="m9 5 10 7-10 7Z"
                />{/if}</svg
            ></button
          ><button
            type="button"
            disabled={busy}
            aria-label="Volgend nummer"
            onclick={() => control("next")}
            ><svg viewBox="0 0 24 24"><path d="M18 5v14M5 5l11 7-11 7Z" /></svg
            ></button
          >
        </div>
      </div>
    </div>
    {#if !pc && typeof attributes.volume_level === "number"}<div class="volume">
        <button
          type="button"
          aria-label={attributes.is_volume_muted
            ? "Geluid aanzetten"
            : "Geluid dempen"}
          disabled={busy}
          onclick={() => control("mute")}
          ><svg viewBox="0 0 24 24"
            ><path
              d="m11 5-6 5H2v4h3l6 5Zm4 3q5 4 0 8"
            />{#if attributes.is_volume_muted}<path
                d="m16 8 5 8m0-8-5 8"
              />{/if}</svg
          ></button
        ><label
          ><span class="sr">Volume</span><input
            type="range"
            min="0"
            max="100"
            value={volume}
            disabled={busy}
            aria-label="Muziekvolume"
            onchange={(event) =>
              control("volume", Number(event.currentTarget.value))}
          /></label
        ><span>{volume}%</span>
      </div>{/if}
    {#if error}<p class="message error" role="status">
        {error}
      </p>{:else if note}<p class="message" role="status">{note}</p>{/if}
  {/if}
</section>

<style>
  .music {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 18px;
    color: var(--hp-text);
  }
  .source {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    color: var(--hp-muted);
    font-size: 11px;
  }
  select {
    max-width: 70%;
    background: #ffffff08;
    color: var(--hp-text);
    border: 1px solid var(--hp-line);
    border-radius: 10px;
    padding: 6px 10px;
    font: inherit;
    color-scheme: dark;
  }
  .track {
    display: flex;
    align-items: center;
    gap: 24px;
    margin: 18px 0 10px;
  }
  .art {
    width: 132px;
    height: 132px;
    border-radius: 20px;
    flex: none;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: radial-gradient(circle at 25% 20%, #264b57, #111c24 70%);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .record {
    width: 108px;
    height: 108px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1px solid #ffffff19;
    background: repeating-radial-gradient(
      circle,
      #0b1017 0 3px,
      #ffffff0b 4px,
      #0b1017 5px 7px
    );
  }
  .record span {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #8adcec;
    color: #0b2530;
    font-size: 23px;
  }
  .info {
    min-width: 0;
    flex: 1;
  }
  small {
    color: var(--hp-muted);
    font-size: 11px;
  }
  h2 {
    margin: 7px 0 4px;
    font-size: 20px;
    line-height: 1.2;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .info p {
    margin: 0;
    font-size: 12px;
    color: var(--hp-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .transport {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    margin-top: 14px;
  }
  button {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    background: transparent;
    color: var(--hp-text);
    border: 0;
    border-radius: 50%;
    cursor: pointer;
  }
  button:hover {
    background: #ffffff0f;
  }
  button:focus-visible,
  select:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--hp-accent);
    outline-offset: 3px;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .play {
    width: 42px;
    height: 42px;
    background: var(--hp-accent);
    color: #07171e;
  }
  .play:hover {
    background: #b6eff7;
  }
  .timeline {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px;
    margin-top: 12px;
    font-size: 10px;
    color: var(--hp-muted);
    font-variant-numeric: tabular-nums;
  }
  progress {
    grid-column: 1/-1;
    width: 100%;
    height: 3px;
    accent-color: var(--hp-accent);
    border: 0;
  }
  .timeline span:last-child {
    text-align: right;
  }
  .volume {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 320px;
    margin: 0 auto;
  }
  .volume label {
    flex: 1;
  }
  input[type="range"] {
    width: 100%;
    accent-color: var(--hp-accent);
  }
  .volume > span {
    color: var(--hp-muted);
    font-size: 11px;
    width: 32px;
    text-align: right;
  }
  .empty {
    padding: 24px 12px;
    color: var(--hp-muted);
    line-height: 1.6;
  }
  .empty strong {
    color: var(--hp-text);
    font-size: 18px;
  }
  .message {
    margin: 8px 0 0;
    font-size: 11px;
    color: var(--hp-muted);
  }
  .error {
    color: #ffc38d;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  @media (max-width: 450px) {
    .art {
      width: 90px;
      height: 90px;
    }
    .track {
      gap: 14px;
    }
    h2 {
      font-size: 17px;
    }
  }
</style>
