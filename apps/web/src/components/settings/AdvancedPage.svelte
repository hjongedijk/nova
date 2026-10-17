<script lang="ts">
  import AdminDialog from "#components/admin/AdminDialog.svelte";
  import ApiStudioSection from "./ApiStudioSection.svelte";
  import ConnectionHistory from "./ConnectionHistory.svelte";
  import ConnectionsSection from "./ConnectionsSection.svelte";
  import HelperPreferencesHistory from "./HelperPreferencesHistory.svelte";
  import InstallationWizard from "./InstallationWizard.svelte";
  import McpStatus from "./McpStatus.svelte";
  import ModelMetrics from "./ModelMetrics.svelte";
  import ModelRoles from "./ModelRoles.svelte";
  import NativeGateway from "./NativeGateway.svelte";
  import OmniRouteAccounts from "./OmniRouteAccounts.svelte";
  import SidebarHistory from "./SidebarHistory.svelte";
  import SidebarTab from "./SidebarTab.svelte";
  import SkillsTab from "./SkillsTab.svelte";
  import StackControl from "./StackControl.svelte";
  import ToolSwitchHistory from "./ToolSwitchHistory.svelte";
  import ToolUsage from "./ToolUsage.svelte";
  import ToolsList from "./ToolsList.svelte";
  import UpdatesSection from "./UpdatesSection.svelte";
  import WindowsAgentPanel from "./WindowsAgentPanel.svelte";
  import WorkspaceProjects from "./WorkspaceProjects.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
</script>

<div class="expert-banner" role="note">
  <strong>Alleen voor als je weet wat je doet.</strong>
  <span
    >Hier staan technische instellingen. NOVA werkt ook zonder dat je hier iets
    aanpast. Elke groep is dicht en laadt pas als je hem opent.</span
  >
</div>

<Disclosure
  kind="advanced"
  title="Modellen en accounts"
  hint="Metingen, accounts, modelkeuze per taak, native gateway en aanbieders"
  id="modellen-expert"
  lazy
  anchors="modelrollen model-role-history-title"
>
  <p class="ds-hint">
    Een nieuwe gratis dienst toevoegen of bevestigen kan eenvoudiger op de
    pagina <a href="/settings?section=modellen">Slimme modellen</a>.
  </p>
  <ConnectionsSection ids={["omniroute"]} />
  <ModelMetrics />
  <OmniRouteAccounts />
  <ModelRoles />
  <NativeGateway />
  <AdminDialog embedded initialView="providers" />
  <h2>OmniRoute</h2>
  <AdminDialog embedded initialView="gateway" />
</Disclosure>

<Disclosure
  kind="advanced"
  title="Overige koppelingen"
  hint="Proxmox, Qdrant, MQTT, Node-RED, Termix, Pangolin en integraties"
  id="koppelingen"
  lazy
  anchors="node-red-flows"
>
  <ConnectionsSection
    ids={["proxmox", "qdrant", "mqtt", "node-red", "termix", "pangolin"]}
  />
  <AdminDialog embedded initialView="integrations" />
  <Disclosure title="Wijzigingsgeschiedenis" kind="history" lazy>
    <ConnectionHistory />
  </Disclosure>
</Disclosure>

<Disclosure
  kind="advanced"
  title="Services en MCP-servers"
  hint="Draaien de achtergrondservices en hulpservers?"
  id="services"
  lazy
>
  <StackControl />
  <McpStatus />
</Disclosure>

<Disclosure
  kind="advanced"
  title="Windows-agent en helper"
  hint="Status, sneltoetsen en geschiedenis"
  id="windows-agent"
  lazy
>
  <WindowsAgentPanel />
  <Disclosure title="Wijzigingsgeschiedenis" kind="history" lazy>
    <HelperPreferencesHistory />
  </Disclosure>
</Disclosure>

<Disclosure
  kind="advanced"
  title="API's koppelen"
  hint="Laat NOVA een externe API leren, testen en gebruiken"
  id="api-koppelingen"
  lazy
>
  <ApiStudioSection />
</Disclosure>

<Disclosure
  kind="advanced"
  title="Alle gereedschappen"
  hint="Elk gereedschap met risico en gebruik"
  id="gereedschappen"
  lazy
  anchors="tool-switch-history"
>
  <ToolUsage />
  <ToolsList />
  <Disclosure title="Wijzigingsgeschiedenis" kind="history" lazy>
    <ToolSwitchHistory />
  </Disclosure>
</Disclosure>

<Disclosure
  kind="advanced"
  title="Eigen vaardigheden"
  hint="Zelf bedachte instructies en koppelingen"
  id="vaardigheden"
  lazy
>
  <SkillsTab />
</Disclosure>

<Disclosure
  kind="advanced"
  title="Codeprojecten"
  hint="Projecten voor NOVA's codehulp"
  id="codeprojecten"
  lazy
>
  <WorkspaceProjects />
</Disclosure>

<Disclosure
  kind="advanced"
  title="Zijbalk en informatiepanelen"
  hint="Kies welke panelen je ziet en waar"
  id="zijbalk"
  lazy
  anchors="sidebar-history"
>
  <SidebarTab />
  <Disclosure title="Wijzigingsgeschiedenis" kind="history" lazy>
    <SidebarHistory />
  </Disclosure>
</Disclosure>

<Disclosure
  kind="advanced"
  title="Updates"
  hint="Welke versie draait er en is er een nieuwe?"
  id="updates"
  lazy
>
  <UpdatesSection />
</Disclosure>

<Disclosure
  kind="advanced"
  title="Actielog"
  hint="Alles wat NOVA heeft gedaan, voor controle"
  id="actielog"
  lazy
>
  <AdminDialog embedded initialView="audit" />
</Disclosure>

<Disclosure
  kind="advanced"
  title="Installatie opnieuw doorlopen"
  hint="De stappen van een nieuwe installatie nog eens langs"
  id="installatie"
  lazy
>
  <InstallationWizard />
</Disclosure>

<style>
  .expert-banner {
    display: flex;
    flex-direction: column;
    gap: var(--s1);
    margin: 0 0 var(--s5);
    padding: var(--s4) var(--s5);
    border: 1px solid var(--amber);
    border-left-width: 8px;
    border-radius: var(--radius);
    background: rgba(246, 210, 126, 0.08);
    color: var(--mist);
  }
  .expert-banner strong {
    font-size: 18px;
    color: var(--amber);
  }
</style>
