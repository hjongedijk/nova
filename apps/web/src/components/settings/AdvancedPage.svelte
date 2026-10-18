<script lang="ts">
  import AdminDialog from "#components/admin/AdminDialog.svelte";
  import ApiStudioSection from "./ApiStudioSection.svelte";
  import InstallationWizard from "./InstallationWizard.svelte";
  import RuntimeSection from "./RuntimeSection.svelte";
  import SidebarHistory from "./SidebarHistory.svelte";
  import SidebarTab from "./SidebarTab.svelte";
  import SkillsTab from "./SkillsTab.svelte";
  import ToolSwitchHistory from "./ToolSwitchHistory.svelte";
  import ToolUsage from "./ToolUsage.svelte";
  import ToolsList from "./ToolsList.svelte";
  import UpdatesSection from "./UpdatesSection.svelte";
  import WorkspaceProjects from "./WorkspaceProjects.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
</script>

<Disclosure
  group="settings-section"
  kind="advanced"
  title="API's koppelen"
  hint="Laat NOVA een externe API leren, testen en gebruiken"
  id="api-koppelingen"
  lazy
>
  <ApiStudioSection />
</Disclosure>

<Disclosure
  group="settings-section"
  kind="advanced"
  title="Alle gereedschappen"
  hint="Elk gereedschap met risico en gebruik"
  id="gereedschappen"
  lazy
  anchors="tool-switch-history"
>
  <Disclosure title="Gebruiksstatistieken" kind="more" lazy
    ><ToolUsage /></Disclosure
  >
  <ToolsList />
  <Disclosure title="Wijzigingsgeschiedenis" kind="history" lazy>
    <ToolSwitchHistory />
  </Disclosure>
</Disclosure>

<Disclosure
  group="settings-section"
  kind="advanced"
  title="Eigen vaardigheden"
  hint="Zelf bedachte instructies en koppelingen"
  id="vaardigheden"
  lazy
>
  <SkillsTab />
</Disclosure>

<Disclosure
  group="settings-section"
  kind="advanced"
  title="Codeprojecten"
  hint="Projecten voor NOVA's codehulp"
  id="codeprojecten"
  lazy
>
  <WorkspaceProjects />
</Disclosure>

<Disclosure
  group="settings-section"
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
  group="settings-section"
  kind="advanced"
  title="Spraak, nieuws en meldingen"
  hint="Spraak naar tekst, embeddings, nieuwsbronnen, ntfy, controledoelen en thuislocatie"
  id="voorkeuren"
  lazy
>
  <RuntimeSection />
</Disclosure>

<Disclosure
  group="settings-section"
  kind="advanced"
  title="Updates"
  hint="Welke versie draait er en is er een nieuwe?"
  id="updates"
  lazy
>
  <UpdatesSection />
</Disclosure>

<Disclosure
  group="settings-section"
  kind="advanced"
  title="Actielog"
  hint="Alles wat NOVA heeft gedaan, voor controle"
  id="actielog"
  lazy
>
  <AdminDialog embedded initialView="audit" />
</Disclosure>

<Disclosure
  group="settings-section"
  kind="advanced"
  title="Installatie opnieuw doorlopen"
  hint="De stappen van een nieuwe installatie nog eens langs"
  id="installatie"
  lazy
>
  <InstallationWizard />
</Disclosure>
