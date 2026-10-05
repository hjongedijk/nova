<script lang="ts">
  import type {
    AuditLogEntry,
    GatewayReport,
    IntegrationsReport,
    MemoryListResponse,
    ProvidersReport,
  } from "@nova/contracts";
  import {
    getAudit,
    getGateway,
    getIntegrations,
    getMemories,
    getProviders,
  } from "#lib/api/admin.ts";
  import { dialogs } from "#lib/stores/dialogs.svelte.ts";
  import Button from "#components/ui/Button.svelte";
  import MemoriesView from "./MemoriesView.svelte";
  import "./admin.css";

  type View = "integrations" | "providers" | "gateway" | "memories" | "audit";
  const VIEWS: [View, string][] = [
    ["integrations", "Integraties"],
    ["providers", "Gratis AI"],
    ["gateway", "OmniRoute"],
    ["memories", "Geheugen"],
    ["audit", "Actielog"],
  ];
  const NAMES: [keyof IntegrationsReport, string][] = [
    ["homeAssistant", "Home Assistant"],
    ["nodeRed", "Node-RED"],
    ["proxmox", "Proxmox"],
    ["mqtt", "MQTT"],
    ["tts", "Spraak"],
    ["shortTermMemory", "Gespreksgeheugen"],
    ["omniroute", "OmniRoute"],
    ["qdrant", "Qdrant"],
  ];
  const PROVIDER_LABELS: Record<string, string> = {
    gemini: "Gemini",
    mistral: "Mistral",
    "cloudflare-ai": "Cloudflare AI",
  };

  type Loaded =
    | { view: "integrations"; data: IntegrationsReport }
    | { view: "providers"; data: ProvidersReport }
    | { view: "gateway"; data: GatewayReport }
    | { view: "memories"; data: MemoryListResponse }
    | { view: "audit"; data: { entries: AuditLogEntry[] } };

  let dialog: HTMLDialogElement | undefined = $state();
  let view = $state<View>("integrations");
  let message = $state("");
  let loaded = $state<Loaded | null>(null);

  async function load(next: View = view): Promise<void> {
    view = next;
    loaded = null;
    message = "Laden…";
    try {
      const result: Loaded =
        next === "integrations"
          ? { view: next, data: await getIntegrations() }
          : next === "providers"
            ? { view: next, data: await getProviders() }
            : next === "gateway"
              ? { view: next, data: await getGateway() }
              : next === "memories"
                ? { view: next, data: await getMemories() }
                : { view: next, data: await getAudit() };
      if (next !== view) return;
      message =
        next === "integrations" || next === "providers"
          ? `Bijgewerkt om ${new Date().toLocaleTimeString("nl-NL")}`
          : "";
      if (result.view === "memories" && result.data.unavailable)
        message = result.data.unavailable;
      loaded = result;
    } catch (error) {
      if (next === view)
        message = error instanceof Error ? error.message : "Niet beschikbaar";
    }
  }

  $effect(() => {
    if (!dialog) return;
    if (dialogs.admin && !dialog.open) {
      dialog.showModal();
      void load();
    } else if (!dialogs.admin && dialog.open) dialog.close();
  });

  const report = (online: boolean | undefined) =>
    online ? "Online" : "Niet bereikbaar";
</script>

{#snippet row(title: string, detail: string)}
  <section class="admin-row">
    <strong>{title}</strong>
    <p>{detail}</p>
  </section>
{/snippet}

<dialog
  id="adminDialog"
  bind:this={dialog}
  aria-labelledby="adminTitle"
  onclose={() => (dialogs.admin = false)}
>
  <div class="admin-heading">
    <h2 id="adminTitle">NOVA beheer</h2>
    <Button id="adminClose" onclick={() => dialog?.close()}>Sluiten</Button>
  </div>
  <nav class="admin-nav" aria-label="Beheerschermen">
    {#each VIEWS as [id, name] (id)}
      <Button data-view={id} aria-current={view === id} onclick={() => load(id)}
        >{name}</Button
      >
    {/each}
  </nav>
  <p id="adminMessage" role="status">{message}</p>
  <div id="adminContent">
    {#if dialogs.admin && loaded}
      {#if loaded.view === "integrations"}
        {@const data = loaded.data}
        {#each NAMES as [key, name] (key)}
          {@const item = data[key] as
            | { online?: boolean; entities?: number; error?: string | null }
            | undefined}
          {#if item}
            {@render row(
              name,
              `${report(item.online)}${item.entities !== undefined ? ` · ${item.entities} entiteiten` : ""}${item.error ? ` · ${item.error}` : ""}`,
            )}
          {/if}
        {/each}
        {#if data.longTermMemory || data.qdrant}
          {@const durable = (data.longTermMemory || data.qdrant)!}
          {@render row(
            "Langetermijngeheugen",
            durable.ready
              ? durable.backend === "omniroute"
                ? "Beschikbaar · OmniRoute (zoekwoorden)"
                : "Beschikbaar"
              : durable.error ||
                  "Nog niet ingesteld · embeddingmodel ontbreekt",
          )}
        {/if}
        {#if data.actions}
          {@render row(
            "Apparaten bedienen",
            data.actions.enabled
              ? "Ingeschakeld · risicovolle acties vragen bevestiging"
              : "Uitgeschakeld in instellingen",
          )}
        {/if}
        {#if data.routing}
          {@render row(
            "Gratis AI",
            data.routing.ready
              ? `Beschikbaar · ${data.routing.enabledModels?.length || 0} toegelaten modellen`
              : "Niet beschikbaar · bekijk Gratis AI voor details",
          )}
        {/if}
        {#if !data.homeAssistant?.configured}
          {@render row(
            "Home Assistant instellen",
            "Open Home Assistant op poort 8123 en bewaar de toegangstoken als HOME_ASSISTANT_TOKEN in .env.",
          )}
        {/if}
      {:else if loaded.view === "providers"}
        {@const data = loaded.data}
        {@const providers = data.providers || []}
        {@const active = providers.filter(
          (provider) => provider.enabledModels > 0,
        )}
        {@render row(
          "Gratis AI",
          data.ready
            ? "Geverifieerde gratis route beschikbaar"
            : "Geen geverifieerde gratis route beschikbaar",
        )}
        {@render row(
          "Beveiliging",
          "Alleen toegelaten gratis accounts en modellen · geen betaalde of lokale fallback",
        )}
        {@render row(
          "Quota",
          "Resterende quota onbekend · OmniRoute beheert limieten en failover",
        )}
        {#each active as provider (provider.provider)}
          {@render row(
            PROVIDER_LABELS[provider.provider] || provider.provider,
            `${provider.enabledModels} toegelaten modellen · gratis account bevestigd${provider.cooldownUntil ? ` · wachttijd tot ${new Date(provider.cooldownUntil).toLocaleString("nl-NL")}` : ""}`,
          )}
        {/each}
        {@render row(
          "Overige providers",
          `${providers.length - active.length} niet actief · niet gebruikt voor chat`,
        )}
        <details>
          <summary>Technische details en modellen</summary>
          <p>{data.reason || data.status || "Geen status beschikbaar"}</p>
          <ul>
            {#each data.enabledModels || [] as model (model)}<li>
                {model}
              </li>{/each}
          </ul>
        </details>
      {:else if loaded.view === "gateway"}
        {@const data = loaded.data}
        {@render row(
          "OmniRoute beheer",
          data.online ? "Verbonden" : data.error || "Niet beschikbaar",
        )}
        {#if data.online}
          {@render row(
            "Geheugen",
            data.memory?.keyword
              ? "Zoekwoordgeheugen beschikbaar · opgeslagen in OmniRoute"
              : "Niet beschikbaar",
          )}
          {@render row(
            "Semantisch zoeken",
            data.memory?.embedding
              ? "Embeddingprovider beschikbaar"
              : "Embeddingprovider nog niet ingesteld",
          )}
          {@render row(
            "Agent Skills",
            `${data.skills?.count || 0} documentatieskills beschikbaar · te raadplegen via NOVA`,
          )}
          {@render row(
            "Uitvoerbare skills",
            "NOVA voert tools uit met eigen risicocontrole en bevestiging",
          )}
          {@render row(
            "Compressie",
            data.compression?.enabled && data.compression?.mode === "lite"
              ? "Lichte compressie · systeemprompt en toolresultaten beschermd"
              : "Uitgeschakeld voor NOVA",
          )}
          {@render row(
            "Cache",
            `${data.cache?.entries || 0} items · ${data.cache?.hits || 0} hits · live toolverzoeken slaan cache over`,
          )}
          {@render row(
            "Sessies",
            "OmniRoute ontvangt de NOVA-sessie voor routering en gebruiksregistratie",
          )}
        {/if}
      {:else if loaded.view === "memories"}
        <MemoriesView
          data={loaded.data}
          say={(text) => (message = text)}
          reload={() => load("memories")}
        />
      {:else}
        {#each loaded.data.entries || [] as item (item.id ?? item.timestamp)}
          {@render row(
            `${item.tool?.replaceAll("_", " ") || "Actie"} · ${item.risk || ""}`,
            `${item.timestamp} · ${item.confirmation || ""} · ${item.result?.verified === true ? "Gecontroleerd" : item.result?.accepted ? "Geaccepteerd, niet bevestigd" : item.result?.ok ? "Uitgevoerd" : item.result?.error || item.phase || ""}`,
          )}
        {/each}
        {#if !loaded.data.entries?.length}
          {@render row("Actielog", "Nog geen acties vastgelegd.")}
        {/if}
      {/if}
    {/if}
  </div>
</dialog>
