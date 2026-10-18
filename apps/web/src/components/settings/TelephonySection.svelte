<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import DangerZone from "./ui/DangerZone.svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import Field from "./ui/Field.svelte";
  import SectionCard from "./ui/SectionCard.svelte";
  import Switch from "./ui/Switch.svelte";
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

<div class="telephony">
  {#if !status}
    <p role="status">{message || "Telefoon laden…"}</p>
    <Button onclick={() => void refresh()}>Opnieuw proberen</Button>
  {:else}
    <SectionCard title="Telefooncentrale" lead="Bel met NOVA via Linphone.">
      <Switch
        label="Telefoon aan"
        hint="Staat standaard uit."
        checked={status.enabled}
        disabled={busy}
        onchange={(event) =>
          void run(() => setTelephonyEnabled(event.currentTarget.checked))}
      />
      {#if status.enabled}
        <p role="status">
          {#if status.connected}De telefooncentrale draait (Asterisk {status.version}).
            Lopende gesprekken: {status.activeCalls}.
          {:else}De telefooncentrale is niet bereikbaar{status.error
              ? `: ${status.error}`
              : ""}. Start hem met
            <code
              >docker compose -f docker-compose.dev.yml --profile telephony up
              -d asterisk</code
            >.{/if}
        </p>
      {/if}
      <Disclosure title="Meer uitleg" kind="more">
        <p class="hint">
          NOVA kan iemand bellen om een boodschap uit te spreken, je waarschuwen
          bij een inkomend gesprek en de deurbel laten overgaan.
        </p>
        <p class="hint">
          Echt praten met NOVA kan ook: bel nummer {status.novaExtension} en zet bij
          Gesprekken “Gesprekken met NOVA toestaan” aan. Een tekstbericht via Linphone
          beantwoordt NOVA via haar chat, maar alleen met informatie (ze voert dan
          geen acties uit).
        </p>
      </Disclosure>
    </SectionCard>

    {#if status.enabled}
      <Disclosure
        title="Toestellen"
        hint="Telefoons en deurbellen koppelen."
        group="settings-section"
      >
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
                    onclick={() =>
                      void run(() => removeTelephonyExtension(ext.id))}
                    >Verwijderen</button
                  >
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="hint">Nog geen toestellen. Voeg hieronder je eerste toe.</p>
        {/if}
        {#if link}
          <div class="set-note" role="status">
            <p>
              Eenmalige koppellink voor toestel {link.id} (10 minuten geldig, werkt
              één keer):
            </p>
            <code>{link.url}</code>
            <p class="hint">
              Open in Linphone “Assistent”, kies “Configuratie ophalen” en plak
              de link. Deel de link met niemand: hij geeft toegang tot het
              toestel.
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
          <Button disabled={busy || !newName.trim()} type="submit"
            >Toevoegen</Button
          >
        </form>
      </Disclosure>

      <Disclosure
        title="Deurbel"
        hint="Kies welke telefoons overgaan."
        group="settings-section"
      >
        {#each phones as ext (ext.id)}
          <Switch
            label="{ext.id} {ext.name}"
            checked={status.ringExtensions.includes(ext.id)}
            disabled={busy}
            onchange={(event) =>
              toggleRing(ext.id, event.currentTarget.checked)}
          />
        {:else}
          <p class="hint">Voeg eerst een telefoon toe.</p>
        {/each}
        <p class="hint">
          Een deurbelapparaat belt nummer {status.doorbellExtension}. Bellen
          naar nummer {status.novaExtension} geeft een melding bij NOVA.
        </p>
      </Disclosure>

      <Disclosure title="Bellen door NOVA" group="settings-section">
        <Switch
          label="NOVA mag mijn eigen toestellen bellen zonder eerst te vragen"
          hint="Externe nummers vragen altijd bevestiging."
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
        <Field id="telVoice" label="Stem van NOVA aan de telefoon">
          <select
            id="telVoice"
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
            <option value="piper"
              >Persoonlijke Piper-stem (indien actief)</option
            >
          </select>
        </Field>
      </Disclosure>

      <Disclosure
        kind="more"
        title="Meer opties"
        hint="Adres, gewone telefoonnummers, contacten en Linphone-uitleg"
      >
        <h3>Adres van de telefooncentrale</h3>
        <p class="hint">
          Het adres waarmee je telefoons de centrale op je thuisnetwerk
          bereiken. Zet poort 5060 en {status.rtpRange} alleen open op je eigen netwerk,
          nooit op internet.
        </p>
        <div class="set-toolbar">
          <input
            id="telHost"
            bind:value={host}
            aria-label="Adres van Asterisk"
          />
          <Button
            disabled={busy || !host}
            onclick={() =>
              void run(
                () => saveTelephonySettings({ publicHost: host }),
                "Adres opgeslagen.",
              )}>Opslaan</Button
          >
        </div>

        <details>
          <summary
            >Gewone telefoonnummers bellen (SIP-trunk){status.trunk.configured
              ? ` · ${status.trunk.host}`
              : " · niet ingesteld"}</summary
          >
          <p class="hint">
            Alleen nodig om gewone nummers te bellen. Je hebt een SIP-account
            bij een provider nodig. Wachtwoorden blijven alleen op deze
            computer.
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
            <Switch
              label="Mijn toestellen mogen zelf extern bellen"
              hint="Risico als een wachtwoord uitlekt."
              bind:checked={trunk.allowExtensionsToDialOut}
            />
            <Button
              disabled={busy || !trunk.host || !trunk.username}
              type="submit">Trunk opslaan</Button
            >
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
            Linphone-account (naam@sip.linphone.org). “Mag met NOVA praten” laat
            alleen dit contact NOVA bellen voor een echt gesprek.
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
                          status!.contacts.filter(
                            (c) => c.name !== contact.name,
                          ),
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
              <Switch
                label="Mag met NOVA praten (bellen naar NOVA)"
                bind:checked={contactTalk}
              />
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
              Installeer Linphone (gratis, open source) op je telefoon of pc.
            </li>
            <li>Voeg hierboven een toestel toe.</li>
            <li>
              Kies “Linphone-koppeling”, open in Linphone “Assistent” en kies
              “Configuratie ophalen”. Plak de link, of importeer het
              XML-bestand.
            </li>
            <li>
              Staat het toestel op “online”? Dan kun je een ander toestel
              bellen, of {status.novaExtension} voor NOVA.
            </li>
            <li>
              Buiten je wifi werkt dit alleen via een VPN naar je thuisnetwerk.
            </li>
          </ol>
        </details>

        {#if status.events.length}
          <h3>Recente gesprekken</h3>
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

        {#if status.trunk.configured}
          <DangerZone>
            <button
              type="button"
              disabled={busy}
              onclick={() => void run(() => removeTelephonyTrunk())}
              >Trunk verwijderen</button
            >
          </DangerZone>
        {/if}
      </Disclosure>
    {:else}
      <p class="hint">
        Zet de telefoon aan om toestellen, deurbel en bellen in te stellen.
      </p>
    {/if}
    {#if message}<p role="status">{message}</p>{/if}
  {/if}
</div>
