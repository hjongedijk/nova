<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import {
    saveTelephonyContacts,
    addTelephonyExtension,
    createProvisioningLink,
    downloadLinphoneFile,
    getTelephony,
    removeTelephonyExtension,
    removeTelephonyTrunk,
    saveTelephonySettings,
    saveTelephonyTrunk,
    setTelephonyEnabled,
    type TelephonyStatus,
  } from "#lib/api/telephony.ts";

  let status = $state<TelephonyStatus | null>(null);
  let busy = $state(false);
  let message = $state("");
  let host = $state("");
  let newName = $state("");
  let contactName = $state("");
  let contactSip = $state("");
  let contactTalk = $state(false);
  let newKind = $state<"phone" | "doorbell">("phone");
  let link = $state<{ id: string; url: string; expiresAt: string } | null>(
    null,
  );
  let trunk = $state({
    host: "",
    username: "",
    secret: "",
    number: "",
    allowExtensionsToDialOut: false,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;

  const phones = $derived(
    (status?.extensions ?? []).filter((item) => item.kind === "phone"),
  );

  async function run(action: () => Promise<unknown>, done = "") {
    if (busy) return;
    busy = true;
    message = "";
    try {
      await action();
      if (done) message = done;
      await refresh();
    } catch (error) {
      message = error instanceof Error ? error.message : "Actie mislukt.";
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    try {
      const next = await getTelephony();
      if (destroyed) return;
      status = next;
      if (!host && document.activeElement?.id !== "telHost")
        host = location.hostname;
    } catch (error) {
      if (!destroyed) {
        status = null;
        message =
          error instanceof Error
            ? error.message
            : "Telefonie is niet bereikbaar.";
      }
    }
  }

  onMount(() => {
    void refresh();
    timer = setInterval(() => void refresh(), 10_000);
  });
  onDestroy(() => {
    destroyed = true;
    if (timer) clearInterval(timer);
  });

  const stateLabel = {
    online: "online",
    offline: "offline",
    unknown: "onbekend",
  };
  const eventLabel: Record<string, string> = {
    inbound: "inkomend",
    doorbell: "deurbel",
    outbound: "uitgaand",
    answered: "opgenomen",
    announcement: "boodschap afgespeeld",
    ended: "beëindigd",
    error: "fout",
  };

  function toggleRing(id: string, on: boolean) {
    const current = (status?.ringExtensions ?? []).filter(
      (item) => item !== id,
    );
    if (on) current.push(id);
    void run(() => saveTelephonySettings({ ringExtensions: current }));
  }
</script>

<section aria-label="Telefonie" class="telephony">
  <p class="hint">
    NOVA bestuurt een eigen Asterisk-telefooncentrale (Asterisk is gratis, open
    source). Hiermee kan NOVA iemand bellen en een boodschap uitspreken, een
    melding geven bij een inkomend gesprek en de deurbel laten overgaan op je
    telefoons. Echt praten met NOVA via de telefoon werkt nog niet.
  </p>

  {#if !status}
    <p role="status">{message || "Telefonie laden…"}</p>
    <Button onclick={() => void refresh()}>Opnieuw proberen</Button>
  {:else}
    <label class="set-row">
      <input
        type="checkbox"
        checked={status.enabled}
        disabled={busy}
        onchange={(event) =>
          void run(() => setTelephonyEnabled(event.currentTarget.checked))}
      />
      Telefonie aan (standaard uit)
    </label>

    {#if status.enabled}
      <p role="status">
        {#if status.connected}Asterisk {status.version} is verbonden. Actieve gesprekken:
          {status.activeCalls}.
        {:else}Asterisk is niet bereikbaar{status.error
            ? `: ${status.error}`
            : ""}. Start de container met
          <code
            >docker compose -f docker-compose.dev.yml --profile telephony up -d
            asterisk</code
          >.{/if}
      </p>
    {:else}
      <p class="hint">
        Zet telefonie aan om de configuratie te genereren (<code
          >dev-data/asterisk/conf</code
        >) met willekeurige wachtwoorden.
      </p>
    {/if}

    <h4>Adres van de telefooncentrale</h4>
    <p class="hint">
      Het adres (IP of hostnaam) waarmee je telefoons Asterisk op je
      thuisnetwerk bereiken. Poort 5060 (SIP) en {status.rtpRange} (audio) mogen alleen
      op je eigen netwerk openstaan, nooit op internet.
    </p>
    <div class="set-toolbar">
      <input id="telHost" bind:value={host} aria-label="Adres van Asterisk" />
      <Button
        disabled={busy || !host}
        onclick={() =>
          void run(
            () => saveTelephonySettings({ publicHost: host }),
            "Adres opgeslagen.",
          )}>Opslaan</Button
      >
    </div>

    <h4>Toestellen</h4>
    {#if status.extensions.length}
      <ul class="set-list">
        {#each status.extensions as ext (ext.id)}
          <li>
            <strong>{ext.id}</strong>
            {ext.name}
            ({ext.kind === "doorbell" ? "deurbel" : "telefoon"}) ·
            {stateLabel[ext.state]}
            <span class="set-toolbar">
              {#if ext.kind === "phone"}
                <button
                  type="button"
                  disabled={busy}
                  onclick={() =>
                    void run(async () => {
                      const made = await createProvisioningLink(ext.id);
                      link = { id: ext.id, ...made };
                    })}>Linphone-koppeling</button
                >
              {/if}
              <button
                type="button"
                disabled={busy}
                onclick={() =>
                  void run(
                    () => downloadLinphoneFile(ext.id),
                    "Bestand opgeslagen.",
                  )}>Download XML</button
              >
              <button
                type="button"
                disabled={busy}
                onclick={() => {
                  if (confirm(`Toestel ${ext.id} verwijderen?`))
                    void run(() => removeTelephonyExtension(ext.id));
                }}>Verwijderen</button
              >
            </span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="hint">Nog geen toestellen.</p>
    {/if}
    {#if link}
      <div class="set-note" role="status">
        <p>
          Eenmalige koppellink voor toestel {link.id} (10 minuten geldig, werkt één
          keer):
        </p>
        <code>{link.url}</code>
        <p class="hint">
          Open Linphone, kies Assistent, "Configuratie ophalen" en plak de link,
          of scan een QR-code van deze link. Deel de link met niemand: hij bevat
          toegang tot het toestel.
        </p>
        <button type="button" onclick={() => (link = null)}>Sluiten</button>
      </div>
    {/if}
    <form
      class="set-toolbar"
      onsubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await addTelephonyExtension(newName, newKind);
          newName = "";
        });
      }}
    >
      <input
        bind:value={newName}
        placeholder="Naam, bijv. Telefoon Anna"
        aria-label="Naam van het toestel"
        maxlength="40"
      />
      <select bind:value={newKind} aria-label="Soort toestel">
        <option value="phone">Telefoon (Linphone)</option>
        <option value="doorbell">Deurbel/intercom</option>
      </select>
      <Button disabled={busy || !newName.trim()} type="submit">Toevoegen</Button
      >
    </form>

    <h4>Wie gaat over bij de deurbel</h4>
    {#each phones as ext (ext.id)}
      <label class="set-row">
        <input
          type="checkbox"
          checked={status.ringExtensions.includes(ext.id)}
          disabled={busy}
          onchange={(event) => toggleRing(ext.id, event.currentTarget.checked)}
        />
        {ext.id}
        {ext.name}
      </label>
    {:else}
      <p class="hint">Voeg eerst een telefoon toe.</p>
    {/each}
    <p class="hint">
      Een deurbelapparaat belt nummer {status.doorbellExtension}. Bellen naar
      nummer {status.novaExtension} geeft een melding bij NOVA.
    </p>

    <h4>Bellen door NOVA</h4>
    <label class="set-row">
      <input
        type="checkbox"
        checked={status.allowInternalCallsWithoutConfirmation}
        disabled={busy}
        onchange={(event) =>
          void run(() =>
            saveTelephonySettings({
              allowInternalCallsWithoutConfirmation:
                event.currentTarget.checked,
            }),
          )}
      />
      NOVA mag mijn eigen toestellen bellen zonder eerst te vragen. Externe nummers
      vragen altijd bevestiging.
    </label>
    <label class="set-row">
      Stem:
      <select
        value={status.voice}
        disabled={busy}
        onchange={(event) =>
          void run(() =>
            saveTelephonySettings({
              voice: event.currentTarget.value as "edge" | "piper",
            }),
          )}
      >
        <option value="edge">Standaard (Nederlandse neurale stem)</option>
        <option value="piper">Persoonlijke Piper-stem (indien actief)</option>
      </select>
    </label>

    <details>
      <summary
        >Externe nummers (SIP-trunk){status.trunk.configured
          ? ` · ${status.trunk.host}`
          : " · niet ingesteld"}</summary
      >
      <p class="hint">
        Alleen nodig om gewone telefoonnummers te bellen. Je hebt een
        SIP-account bij een provider nodig; wachtwoorden worden alleen lokaal
        bewaard (0600).
      </p>
      <form
        class="set-grid"
        onsubmit={(event) => {
          event.preventDefault();
          void run(
            () =>
              saveTelephonyTrunk({
                ...trunk,
                secret: trunk.secret || undefined,
              }),
            "Trunk opgeslagen.",
          ).then(() => (trunk.secret = ""));
        }}
      >
        <input
          bind:value={trunk.host}
          placeholder="sip.provider.nl"
          aria-label="Trunkhost"
        />
        <input
          bind:value={trunk.username}
          placeholder="Gebruikersnaam"
          aria-label="Trunk-gebruikersnaam"
        />
        <input
          type="password"
          autocomplete="off"
          bind:value={trunk.secret}
          placeholder="Wachtwoord (leeg laten = ongewijzigd)"
          aria-label="Trunkwachtwoord"
        />
        <input
          bind:value={trunk.number}
          placeholder="Eigen nummer +31…"
          aria-label="Eigen nummer"
        />
        <label class="set-row">
          <input
            type="checkbox"
            bind:checked={trunk.allowExtensionsToDialOut}
          />
          Mijn toestellen mogen zelf extern bellen (risico bij gelekt wachtwoord)
        </label>
        <Button disabled={busy || !trunk.host || !trunk.username} type="submit"
          >Trunk opslaan</Button
        >
        {#if status.trunk.configured}
          <button
            type="button"
            disabled={busy}
            onclick={() => void run(() => removeTelephonyTrunk())}
            >Trunk verwijderen</button
          >
        {/if}
      </form>
    </details>

    <details>
      <summary
        >Contacten (bellen op naam){status.contacts.length
          ? ` · ${status.contacts.length}`
          : ""}</summary
      >
      <p class="hint">
        Mensen die NOVA via de SIP-trunk kan bellen, bijvoorbeeld je
        Linphone-account (naam@sip.linphone.org). Het domein moet de trunkhost
        zijn. NOVA heeft een eigen tweede Linphone-account nodig voor de trunk;
        daarmee bel jij NOVA ook van buitenaf. “Mag met NOVA praten” laat alleen
        dit contact haar bellen voor een echt gesprek (uit tenzij je het kiest).
      </p>
      <ul>
        {#each status.contacts as contact (contact.name)}
          <li>
            {contact.name} · {contact.sip}{contact.allowConversation
              ? " · mag met NOVA praten"
              : ""}
            <button
              type="button"
              disabled={busy}
              onclick={() =>
                void run(
                  () =>
                    saveTelephonyContacts(
                      status!.contacts.filter((c) => c.name !== contact.name),
                    ),
                  "Contact verwijderd.",
                )}>Verwijderen</button
            >
          </li>
        {/each}
      </ul>
      {#if status.trunk.configured}
        <form
          class="set-grid"
          onsubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                saveTelephonyContacts([
                  ...status!.contacts,
                  {
                    name: contactName.trim(),
                    sip: contactSip.trim(),
                    allowConversation: contactTalk,
                  },
                ]),
              "Contact opgeslagen.",
            ).then(() => {
              contactName = "";
              contactSip = "";
              contactTalk = false;
            });
          }}
        >
          <input
            bind:value={contactName}
            placeholder="Naam, bijvoorbeeld Dylan"
            aria-label="Contactnaam"
          />
          <input
            bind:value={contactSip}
            placeholder="gebruiker@sip.linphone.org"
            aria-label="SIP-adres"
          />
          <label class="set-row">
            <input type="checkbox" bind:checked={contactTalk} />
            Mag met NOVA praten (bellen naar NOVA)
          </label>
          <Button
            disabled={busy || !contactName.trim() || !contactSip.trim()}
            type="submit">Contact toevoegen</Button
          >
        </form>
      {:else}<p>Stel eerst een SIP-trunk in.</p>{/if}
    </details>

    <details>
      <summary>Linphone instellen</summary>
      <ol>
        <li>
          Installeer Linphone (gratis, open source; Android, iOS, Windows,
          macOS, Linux) op je telefoon of pc.
        </li>
        <li>
          Voeg hierboven een toestel toe en stel het adres van Asterisk in.
        </li>
        <li>
          Kies "Linphone-koppeling" en open in Linphone Assistent, "Configuratie
          ophalen"; plak de link. Of download het XML-bestand en importeer het.
        </li>
        <li>
          Je telefoon staat nu als toestel geregistreerd (status "online"
          hierboven). Bel het nummer van een ander toestel, of
          {status.novaExtension} voor NOVA.
        </li>
        <li>
          Buiten je wifi werkt het alleen via een VPN naar je thuisnetwerk; zet
          SIP niet op internet.
        </li>
      </ol>
    </details>

    {#if status.events.length}
      <h4>Recente gesprekken</h4>
      <ul class="set-list">
        {#each status.events.slice(0, 10) as event, index (index)}
          <li>
            {new Date(event.at).toLocaleTimeString("nl-NL")} · {eventLabel[
              event.type
            ] ?? event.type}
            {event.from ?? ""}{event.to ? ` → ${event.to}` : ""}
          </li>
        {/each}
      </ul>
    {/if}
    {#if message}<p role="status">{message}</p>{/if}
  {/if}
</section>
