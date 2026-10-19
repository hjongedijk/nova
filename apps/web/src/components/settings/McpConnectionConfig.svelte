<script lang="ts">
  import type { McpServerConfigStatus } from "@nova/contracts";
  import Button from "#components/ui/Button.svelte";
  import {
    getMcpServerConfig,
    getMcpServerCatalog,
    changeMcpServerCatalog,
    setMcpServerEnabled,
    saveMcpServerConfig,
  } from "#lib/api/settings.ts";

  let {
    id,
    onSaved,
    connect = false,
  }: {
    id: "caldav" | "imap" | "github";
    connect?: boolean;
    onSaved: () => void | Promise<void>;
  } = $props();
  const fields = $derived(
    id === "caldav"
      ? [
          { key: "CALDAV_URL", label: "CalDAV HTTPS-adres", type: "url" },
          { key: "CALDAV_USERNAME", label: "Gebruikersnaam", type: "text" },
          { key: "CALDAV_PASSWORD", label: "Wachtwoord", type: "password" },
        ]
      : id === "imap"
        ? [
            { key: "IMAP_HOST", label: "IMAP-hostnaam", type: "text" },
            {
              key: "IMAP_USER",
              label: "E-mailadres / gebruikersnaam",
              type: "text",
            },
            { key: "IMAP_PASSWORD", label: "Wachtwoord", type: "password" },
          ]
        : [
            {
              key: "GITHUB_REPOSITORY_OWNER",
              label: "GitHub-gebruiker of organisatie",
              type: "text",
            },
            {
              key: "GITHUB_REPOSITORY_NAME",
              label: "Repository",
              type: "text",
            },
            {
              key: "GITHUB_PERSONAL_ACCESS_TOKEN",
              label: "Fijnmazige read-only token",
              type: "password",
            },
          ],
  );
  let opened = $state(false);
  let busy = $state(false);
  let error = $state("");
  let note = $state("");
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
      error = "Verbindingsgegevens konden niet worden geladen.";
    } finally {
      busy = false;
    }
  }

  async function save(clear = false) {
    busy = true;
    error = "";
    note = "";
    try {
      status = await saveMcpServerConfig(id, values, clear);
      values = {};
      note = clear ? "Opgeslagen gegevens gewist." : "Gegevens opgeslagen.";
      if (connect && !clear) {
        if (!status.fields.every((field) => field.configured)) {
          error =
            "Gegevens opgeslagen. Vul de ontbrekende velden in om te verbinden.";
          return;
        }
        const catalog = await getMcpServerCatalog();
        if (!catalog.installed.includes(id)) {
          const added = await changeMcpServerCatalog(id, "add");
          if (!added.ok)
            throw new Error(added.error || "Koppeling toevoegen mislukt.");
        }
        const enabled = await setMcpServerEnabled(id, true);
        if (!enabled.ok)
          throw new Error(enabled.error || "Koppeling inschakelen mislukt.");
        note = "Gegevens opgeslagen. Koppeling ingeschakeld.";
      }
      await onSaved();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Opslaan is mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<Button onclick={open} disabled={busy}>
  {opened
    ? "Invoer sluiten"
    : id === "imap"
      ? "IMAP instellen"
      : id === "caldav"
        ? "CalDAV instellen"
        : "Koppeling instellen"}
</Button>
{#if opened}
  <section aria-label={`MCP-koppeling ${id}`}>
    <p>
      Lege velden behouden je huidige gegevens. Wachtwoorden worden nooit
      teruggetoond. Opslaan werkt de actieve verbinding bij.
    </p>
    {#if id === "github"}
      <p>
        Gebruik een fijnmazige token die alleen toegang heeft tot deze
        repository en uitsluitend lezen op Metadata, Contents, Issues, Pull
        requests en Actions. NOVA controleert elke gereedschapsaanroep op de
        ingestelde eigenaar en repository. GitHub-waarden worden alleen lokaal
        bewaard; de token wordt nooit teruggetoond.
      </p>
    {/if}
    <div class="connection-fields">
      {#each fields as field (field.key)}
        <label>
          {field.label}
          <span>
            {status?.fields.find((item) => item.key === field.key)?.configured
              ? "ingesteld"
              : "ontbreekt"}
            {#if status?.fields.find((item) => item.key === field.key)?.value}
              · {status.fields.find((item) => item.key === field.key)?.value}
            {/if}
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
    </div>
    {#if note}<p role="status">{note}</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <Button onclick={() => save()} disabled={busy}>
      {busy ? "Opslaan…" : connect ? "Opslaan en verbinden" : "Opslaan"}
    </Button>
    <Button
      onclick={() => void save(true)}
      disabled={busy || !status?.fields.some((field) => field.configured)}
      >Waarden wissen</Button
    >
  </section>
{/if}

<style>
  .connection-fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
    gap: 12px;
    margin-block: 12px;
  }
  label {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
    align-content: start;
  }
  label span {
    color: var(--dim);
    font-size: 12px;
    align-self: center;
  }
  input {
    grid-column: 1 / -1;
    min-width: 0;
  }
</style>
