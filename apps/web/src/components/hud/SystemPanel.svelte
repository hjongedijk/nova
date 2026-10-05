<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";

  type Row = { name: string; text: string; cls: "ok" | "bad" | "" };

  // The browser's own speech recognition ("Gehoor").
  const hearing =
    typeof window !== "undefined" &&
    Boolean(
      (window as unknown as Record<string, unknown>).SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition,
    );

  const rows = $derived.by<Row[]>(() => {
    const data = dashboard.health;
    const failed = dashboard.healthFailed;
    const row = (
      name: string,
      yes: unknown,
      on = "online",
      off = "offline",
    ): Row => {
      if (failed) return { name, text: "onbekend", cls: "bad" };
      if (!data) return { name, text: "…", cls: "" };
      return yes
        ? { name, text: on, cls: "ok" }
        : { name, text: off, cls: "bad" };
    };
    const tools =
      typeof data?.tools === "number"
        ? data.tools
        : (data?.tools?.available ?? data?.toolCount);
    return [
      failed
        ? { name: "API", text: "fout", cls: "bad" }
        : row("API", data?.ok, "online", "fout"),
      row("MQTT", data?.mqtt),
      row("Stem", data?.tts),
      {
        name: "Gehoor",
        text: hearing ? "beschikbaar" : "niet beschikbaar",
        cls: hearing ? "ok" : "bad",
      },
      row("Geheugen", data?.memory?.persistent),
      row("OmniRoute", data?.services?.omniroute?.online, "online", "onbekend"),
      failed
        ? { name: "Tools", text: "—", cls: "bad" }
        : !data
          ? { name: "Tools", text: "…", cls: "" }
          : {
              name: "Tools",
              text: String(tools ?? ""),
              cls: (tools ?? 0) > 0 ? "ok" : "bad",
            },
      row(
        "Proxmox",
        data?.state?.proxmox?.online && !data.state.proxmox.stale,
        "online",
        "onbekend",
      ),
    ];
  });

  const count = $derived(
    dashboard.health || dashboard.healthFailed
      ? `${rows.filter((r) => r.cls === "ok").length}/${rows.length}`
      : "–",
  );
</script>

<section class="hud" data-panel="systeem" aria-label="Systeem">
  <h2>Systeem <em>{count}</em></h2>
  <ul>
    {#each rows as row (row.name)}
      <li><i></i><span>{row.name}</span><b class={row.cls}>{row.text}</b></li>
    {/each}
  </ul>
</section>
