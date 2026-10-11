<script lang="ts">
  import type { McpServerConfigStatus } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getMcpServerConfig,
    saveMcpServerConfig,
  } from "#lib/api/settings.ts";

  let {
    id,
    onSaved,
  }: { id: "caldav" | "imap"; onSaved: () => void | Promise<void> } = $props();
  const fields = $derived(
    id === "caldav"
      ? [
          { key: "CALDAV_URL", label: "CalDAV HTTPS-adres", type: "url" },
          { key: "CALDAV_USERNAME", label: "Gebruikersnaam", type: "text" },
          { key: "CALDAV_PASSWORD", label: "Wachtwoord", type: "password" },
        ]
      : [
          { key: "IMAP_HOST", label: "IMAP-hostnaam", type: "text" },
          {
            key: "IMAP_USER",
            label: "E-mailadres / gebruikersnaam",
            type: "text",
          },
          { key: "IMAP_PASSWORD", label: "Wachtwoord", type: "password" },
        ],
  );
  let opened = $state(false);
  let busy = $state(false);
  let error = $state("");
  let status = $state<McpServerConfigStatus | null>(null);
  let values = $state<Record<string, string>>({});

  async function open() {
    opened = !opened;
    if (!opened) return;
    busy = true;
    error = "";
    try {
      status = await getMcpServerConfig(id);
    } catch {
      error = "MCP-instellingen konden niet veilig worden geladen.";
    } finally {
      busy = false;
    }
  }

  async function save(clear = false) {
    busy = true;
    error = "";
    try {
      status = await saveMcpServerConfig(id, values, clear);
      values = {};
      await onSaved();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Opslaan is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<Button onclick={open} disabled={busy}>
  {opened ? "Koppeling verbergen" : "Koppeling instellen"}
</Button>
{#if opened}
  <section aria-label={`MCP-koppeling ${id}`}>
    <p>
      Waarden blijven lokaal in NOVA's gegevensmap met bestandsrechten 0600.
      Bestaande waarden worden nooit teruggestuurd. Lege velden behouden de
      huidige waarde; opslaan herstart deze MCP-verbinding als hij actief is.
    </p>
    {#each fields as field (field.key)}
      <label>
        {field.label}
        <span>
          {status?.fields.find((item) => item.key === field.key)?.configured
            ? "ingesteld"
            : "ontbreekt"}
        </span>
        <input
          type={field.type}
          autocomplete="off"
          bind:value={values[field.key]}
          placeholder="Leeg laten om te behouden"
          disabled={busy}
        />
      </label>
    {/each}
    {#if error}<p role="alert">{error}</p>{/if}
    <Button onclick={() => save()} disabled={busy}>
      {busy ? "Opslaan…" : "Opslaan"}
    </Button>
    <Button
      onclick={() => {
        if (window.confirm("Alle lokale waarden van deze koppeling wissen?"))
          void save(true);
      }}
      disabled={busy || !status?.fields.some((field) => field.configured)}
      >Waarden wissen</Button
    >
  </section>
{/if}
