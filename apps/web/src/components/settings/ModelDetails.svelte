<script lang="ts">
  import AdminDialog from "#components/admin/AdminDialog.svelte";
  import ConnectionsSection from "./ConnectionsSection.svelte";
  import ModelMetrics from "./ModelMetrics.svelte";
  import ModelRoles from "./ModelRoles.svelte";
  import NativeGateway from "./NativeGateway.svelte";
  import OmniRouteAccounts from "./OmniRouteAccounts.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
</script>

<Disclosure
  group="settings-section"
  kind="advanced"
  title="Geavanceerde modelinstellingen"
  hint="Gatewayverbinding, accounts, modelrollen en metingen"
  id="modellen-expert"
  lazy
  anchors="modelrollen model-role-history-title"
>
  <ConnectionsSection ids={["omniroute"]} showHelp={false} />
  <Disclosure
    title="Beschikbaarheid en gebruik"
    hint="Actuele route, modellen en metingen"
    lazy><ModelMetrics /></Disclosure
  >
  <Disclosure
    title="Accountbeheer"
    hint="Sleutels, limieten en accountdetails"
    lazy><OmniRouteAccounts /></Disclosure
  >
  <Disclosure
    title="Modelkeuze per taak"
    id="modelrollen"
    anchors="modelrollen model-role-history-title"
    lazy><ModelRoles /></Disclosure
  >
  <Disclosure title="NOVA-gateway" lazy><NativeGateway /></Disclosure>
  <Disclosure title="Aanbieders en catalogus" lazy
    ><AdminDialog embedded initialView="providers" /></Disclosure
  >
  <Disclosure title="OmniRoute-diagnostiek" lazy
    ><AdminDialog embedded initialView="gateway" /></Disclosure
  >
</Disclosure>
