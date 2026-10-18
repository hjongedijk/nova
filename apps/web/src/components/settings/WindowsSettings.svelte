<script lang="ts">
  import { onMount } from "svelte";
  import type { WindowsAgentStatus } from "@nova/contracts";
  import { getWindowsAgentStatus } from "#lib/api/settings.ts";
  import Button from "#components/ui/Button.svelte";
  import ConnectionsSection from "./ConnectionsSection.svelte";
  import DesktopSection from "./DesktopSection.svelte";
  import DevicesSection from "./DevicesSection.svelte";
  import WindowsAgentPanel from "./WindowsAgentPanel.svelte";
  import HelperPreferencesHistory from "./HelperPreferencesHistory.svelte";
  import Disclosure from "./ui/Disclosure.svelte";

  let status = $state<WindowsAgentStatus | null>(null);
  let busy = $state(false);
  let error = $state("");
  async function refresh() {
    busy = true;
    error = "";
    try {
      status = await getWindowsAgentStatus();
    } catch {
      status = null;
      error =
        "De pc-status is niet beschikbaar. Controleer de koppeling en probeer opnieuw.";
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void refresh();
  });
  const allowed = (value: boolean | undefined) =>
    value === undefined ? "Nog niet gemeld" : value ? "Toegestaan" : "Uit";
</script>

<div class="windows-settings">
  <div class="pc-status" role="status">
    <strong
      >{status?.available
        ? status.paused
          ? "Pc verbonden · gepauzeerd"
          : "Pc verbonden"
        : "Nog geen verbinding met de pc"}</strong
    >
    <div class="pc-actions">
      <Button
        go
        href="https://github.com/hjongedijk/nova/releases?q=windows-v"
        target="_blank"
        rel="noopener noreferrer">Windows-agent downloaden</Button
      >
      <button type="button" disabled={busy} onclick={refresh}
        >{busy ? "Controleren…" : "Verbinding controleren"}</button
      >
    </div>
  </div>
  {#if error || status?.error}<p class="hint">
      {error || status?.error}
    </p>{/if}
  <p class="hint">
    Ctrl+Alt+Shift+K stopt pc-bediening direct. <a href="/"
      >Pc bekijken op het beginscherm</a
    >
  </p>
  <Disclosure
    title="Verbinding"
    hint="Koppelcode en agent-adres"
    id="pc"
    anchors="connection-windows"
    group="settings-section"
  >
    <ConnectionsSection ids={["windows"]} showHelp={false} expanded />
  </Disclosure>
  <Disclosure
    title="Pc-status en beheerrechten"
    hint="Beschikbare functies en Windows UAC"
    id="windows-access"
    group="settings-section"
  >
    {#if status?.available}
      <dl class="access-list">
        <div>
          <dt>Windows-agent</dt>
          <dd>{status.version ?? "Versie onbekend"}</dd>
        </div>
        <div>
          <dt>Beeldschermen bekijken</dt>
          <dd>{allowed(status.permissions?.view)}</dd>
        </div>
        <div>
          <dt>Muis en toetsenbord</dt>
          <dd>{allowed(status.permissions?.control)}</dd>
        </div>
        <div>
          <dt>Eigen browser bedienen</dt>
          <dd>{allowed(status.permissions?.browser)}</dd>
        </div>
        <div>
          <dt>Windows-beheerrechten</dt>
          <dd>
            {status.elevated === undefined
              ? "Nog niet gemeld"
              : status.elevated
                ? "Actief"
                : "Niet actief"}
          </dd>
        </div>
      </dl>
    {/if}
    <p class="hint">
      De koppelcode geeft de Windows-agent toegang tot deze pc. Aanvullende
      lokale toestemmingen zijn niet nodig.
    </p>
    <p class="hint">
      NOVA vraagt bij het starten Windows-beheerrechten. Weiger je die, dan
      blijft NOVA zonder beheerrechten werken. UAC-prompts en Windows-aanmelding
      blijven handmatig.
    </p>
  </Disclosure>

  <Disclosure
    title="Meekijken en bedienen"
    hint="Schermtoegang, sessies en noodstop"
    id="pc-bedienen"
    group="settings-section"
    ><DesktopSection />
    <p class="hint">
      Gebruik <a href="/">Pc bekijken op het beginscherm</a> voor het live schermbeeld.
      Ctrl+Alt+Shift+K is de noodstop op je pc.
    </p>
  </Disclosure>
  <Disclosure
    title="Helper en achtergrond"
    hint="Weergave en beeldschermen"
    id="windows-appearance"
    group="settings-section"><DevicesSection part="windows" /></Disclosure
  >
  <Disclosure
    group="settings-section"
    title="Status en sneltoetsen"
    hint="Agentversie, helpervenster en sneltoetsen"
    id="windows-agent"
    lazy
  >
    <WindowsAgentPanel />
    <Disclosure title="Helperinstellingen terugzetten" kind="history" lazy>
      <HelperPreferencesHistory />
    </Disclosure>
  </Disclosure>
</div>

<style>
  .pc-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    flex-wrap: wrap;
    padding: var(--s4) 0;
    border-bottom: 1px solid var(--line);
  }
  .pc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }
  .access-list {
    margin: var(--s4) 0;
  }
  .access-list div {
    display: grid;
    grid-template-columns: minmax(150px, 1fr) minmax(100px, 1fr);
    gap: var(--s4);
    padding: var(--s2) 0;
  }
  dt {
    color: var(--dim);
  }
  dd {
    margin: 0;
  }
</style>
