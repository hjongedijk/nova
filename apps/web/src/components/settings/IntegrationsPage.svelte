<script lang="ts">
  import AdminDialog from "#components/admin/AdminDialog.svelte";
  import ConnectionsSection from "./ConnectionsSection.svelte";
  import ConnectionHistory from "./ConnectionHistory.svelte";
  import McpConnectionConfig from "./McpConnectionConfig.svelte";
  import McpStatus from "./McpStatus.svelte";
  import StackControl from "./StackControl.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
</script>

<section id="home-assistant">
  <ConnectionsSection ids={["home-assistant"]} showHelp={false} />
</section>
<section id="koppelingen">
  <h2>Verbonden diensten</h2>
  <p class="hint">Open een dienst om de verbinding en toegang te beheren.</p>
  <ConnectionsSection
    ids={["proxmox", "qdrant", "mqtt", "node-red", "termix", "pangolin"]}
    showHelp={false}
  />
  <section aria-label="Mail en agenda">
    <h3>Mail en agenda</h3>
    <div class="settings-integration">
      <h4>Mail · IMAP</h4>
      <p class="hint">Verbind je mailbox via IMAP met TLS (poort 993).</p>
      <McpConnectionConfig connect id="imap" onSaved={() => {}} />
    </div>
    <div class="settings-integration">
      <h4>Agenda · CalDAV</h4>
      <p class="hint">
        Gebruik het HTTPS-adres van je agenda en je account of app-wachtwoord.
      </p>
      <McpConnectionConfig connect id="caldav" onSaved={() => {}} />
    </div>
  </section>
  <Disclosure
    title="Wijzigingsgeschiedenis van verbindingen"
    kind="history"
    lazy><ConnectionHistory /></Disclosure
  >
  <Disclosure title="Status van integraties" kind="more" lazy
    ><AdminDialog embedded initialView="integrations" /></Disclosure
  >
</section>
<Disclosure
  title="Services en MCP"
  hint="Draaiende achtergrondservices en aanvullende gereedschappen"
  id="services"
  lazy
>
  <StackControl />
  <McpStatus />
</Disclosure>
