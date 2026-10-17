# Linphone end-to-end versleutelde chat met NOVA

Status: **gebouwd en lokaal getest met de echte SDK tegen een nep-registrar, maar nog nooit gebruikt met het echte Linphone-account.** Wat hieronder "geverifieerd" heet is op 2026-10-17 op deze machine uitgeprobeerd (Debian 13, Docker, internet). "Niet geverifieerd" staat onderaan in een eigen lijst. Er is niets gedeployed, gepusht of getagd, en `/opt/nova` en de draaiende containers zijn niet aangeraakt.

## Wat vandaag werkt en wat niet

- **Gewone Linphone-tekst** (CPIM `text/plain`) komt via Asterisk en de SIP-relay bij NOVA (zie [Telefonie](telephony.md)). Het account daarvoor is de Asterisk-trunk.
- **Versleutelde chat** (Linphones "veilige" 1:1-chatrooms) kan met Asterisk niet: het is geen SIP `MESSAGE` maar een Flexisip-_conference-factory_-chatroom met LIME/X3DH Double-Ratchet-sleutels (Linphones LIME-server). Daar is een client voor nodig die dat protocol spreekt: liblinphone. Dat doet de brug in `deploy/linphone-chat`.

## Ontwerp: hetzelfde account, twee registraties

Besluit: de brug gebruikt **hetzelfde Linphone-account als de Asterisk-trunk** (dezelfde SIP-identiteit). Er is dus een account met twee registraties bij Flexisip:

```
Linphone (telefoon) ==E2E (LIME)==> Flexisip (sip.linphone.org) --- forkt naar alle registraties van het account
                                       |                      |
                       Asterisk (trunk, via SIP-relay)   linphone-chat (liblinphone, eigen apparaat)
                       oproepen + gewone tekst            alleen versleutelde 1:1-chat
                                                                |  JSON + token, intern netwerk `nova`
                                                          NOVA  POST /api/integrations/linphone-chat/message
```

Gebruiker en domein haalt de brug bij NOVA op (`POST .../allowlist` geeft `identity` = `sip:<trunk.username>@<trunk.host>`, nooit het wachtwoord); alleen het wachtwoord staat in een geheimbestand dat jij aanmaakt. De gebruiker hoeft maar een contact te hebben (het bestaande NOVA-contact).

### De regels bij forking (Flexisip stuurt naar elke registratie)

| Onderwerp                     | Regel in de brug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Bewijs                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Oproepen**                  | De brug neemt nooit op, wijst nooit af en beeindigt nooit iets. Alle audio-, video- en tekstcodecs staan uit (`payload_type.enable(False)`), `auto_send_ringing_enabled = False`. Een INVITE wordt daardoor door de SDK zelf direct met **488 Not Acceptable Here** (4xx, geen globale fout) geweigerd, zonder 180/183 en zonder 603. De call-listener telt alleen (`callsIgnored` in `/health`). **Risico:** een 4xx van een tak laat Flexisip de andere takken (Asterisk) gewoon laten doorlopen; een 603 zou de hele call doden en dat gebeurt dus niet. | Rooktest (echte SDK): INVITE met PCMU/PCMA-aanbod geeft `100 Trying` en `488`, nooit `180`, `183`, `200`, `480`, `486` of `603`.                                   |
| **Cleartext-berichten**       | Worden **genegeerd** (alleen geteld: `cleartextIgnored`). De Asterisk-route beantwoordt ze al. Zo is er nooit een dubbel antwoord. Alleen kamers met beveiligingsniveau `Encrypted` of `Safe` van een toegestaan contact, met precies 1 andere deelnemer, worden beantwoord; groepen, vreemden en `Unsafe` niet. De oude optie `NOVA_CHAT_ALLOW_CLEARTEXT` is verwijderd (zou dubbele antwoorden geven).                                                                                                                                                    | Rooktest: cleartext `MESSAGE` wordt geteld, niet doorgestuurd. Unit-tests voor alle gevallen.                                                                      |
| **Dedupe-regel**              | Cleartext = Asterisk, versleuteld = brug. Versleutelde kamerberichten zijn aan het apparaat-GRUU van de brug geadresseerd (`gr=urn:uuid:<device-id>`), Asterisk heeft geen GRUU en geen `+org.linphone.specs`-groupchat-capability en hoort dus niet in een chatroom te komen.                                                                                                                                                                                                                                                                              | GRUU met de device-id zichtbaar in de LIME-logregel van de rooktest. Dat Asterisk niets van de versleutelde kamer ziet is **niet** geverifieerd.                   |
| **200 OK op cleartext**       | Let op: de SDK beantwoordt een cleartext `MESSAGE` zelf met `200 OK`, ook al negeert de brug de tekst. Als Flexisip het eerste 2xx als "afgeleverd" telt en dan stopt, zou Asterisk het bericht niet krijgen. Flexisip behoort cleartext naar alle registraties te sturen, maar dat is **niet geverifieerd**: controleer het met de testtap hieronder.                                                                                                                                                                                                      | Waargenomen: `200 Ok` van de brug op een cleartext MESSAGE.                                                                                                        |
| **Apparaat-identiteit**       | Een vaste UUID in `/data/device-id` (0600, atomisch geschreven) wordt als `misc/uuid` aan liblinphone gegeven en wordt `+sip.instance` in het Contact en daarmee de GRUU waar de LIME-sleutels bij horen. User-Agent `NOVA-chat-bridge/0.2` (Asterisk: `NOVA-PBX`). Verlies van het volume = nieuw apparaat = nieuwe LIME-inschrijving.                                                                                                                                                                                                                     | Rooktest: User-Agent en `+sip.instance` in de REGISTER, zelfde id na herstart met hetzelfde volume.                                                                |
| **Geen botsing met Asterisk** | Ander Contact (eigen `+sip.instance`, ander adres/poort, TLS), eigen User-Agent, `expires=3600` (zoals Asterisk), liblinphone ververst zelf. Bij stoppen wordt alleen het **eigen** contact afgemeld (`Expires: 0` op dat contact, nooit `Contact: *`).                                                                                                                                                                                                                                                                                                     | Rooktest: geen `Contact: *` in de REGISTERs. Het gedrag van Flexisip met twee registraties (max. contacten per account, GRUU-toewijzing) is **niet** geverifieerd. |
| **Ontvangstberichten**        | IMDN (afgeleverd/gelezen) en typ-indicaties naar de afzender staan uit (`im_notif_policy.clear()`): niets verlaat de brug behalve echte antwoorden.                                                                                                                                                                                                                                                                                                                                                                                                         | Configuratie, niet apart getest.                                                                                                                                   |

Verder: berichtinhoud komt nooit in de logs (alleen toestanden en tellers; liblinphone-logniveau Warning, zet nooit trace/debug aan). De brug leest de allow-list elke minuut bij NOVA (`contacten met "Mag met NOVA praten"`); leeg of onbereikbaar betekent: niemand. Kamers van vreemden en groepen worden verlaten.

## Wat er in de repo staat

| Pad                                                                                     | Inhoud                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/linphone-chat/Dockerfile`                                                       | Multi-stage `ubuntu:24.04`, wheel `linphone-5.5.32-cp312` vastgepind met **sha256-controle** (een foute hash laat de bouw mislukken: getest), niet-root uid 10001, 881 MB. |
| `deploy/linphone-chat/bridge.py`                                                        | De brug.                                                                                                                                                                   |
| `deploy/linphone-chat/test_bridge.py`                                                   | 11 unit-tests (beleid, cleartext, groepen, oproepen alleen tellen, device-id, geen tekst in logs, NOVA-client).                                                            |
| `deploy/linphone-chat/smoke_core.py`                                                    | Rooktest met de echte SDK en een nep-registrar op 127.0.0.1: registratie/User-Agent/instance-id, oproep (488), cleartext genegeerd, herstart-stabiliteit.                  |
| `deploy/docker-compose.yml`                                                             | Service `linphone-chat` onder profiel `linphone-chat`, `build: ./linphone-chat`, geheimen, healthcheck, limieten.                                                          |
| `.github/workflows/release.yml`                                                         | `linphone-chat` zit in `nova-compose.tar.gz` (net als `asterisk`). **Alleen de bronnen**; de image wordt nergens gepubliceerd (GPLv3).                                     |
| `apps/api/src/telephony/messaging*.ts`, `apps/api/test/telephony/linphone-chat.test.ts` | `integrations/linphone-chat/{message,allowlist}`; allowlist geeft nu ook `identity`.                                                                                       |

## Productie: stap voor stap

Alles als root in de map met `docker-compose.yml` (meestal `/opt/nova`). Eerst een nieuwe release uitpakken zodat `linphone-chat/` en de compose er staan.

1. **Geheimbestanden maken, zonder iets te tonen.** De echte JSON-sleutels in `nova-data/telephony.json` zijn `trunk.secret` (het SIP-wachtwoord van de trunk), `trunk.username`, `trunk.host` en `messageToken`:

   ```
   install -d -m 0700 secrets
   ( umask 277; jq -je '.trunk.secret' nova-data/telephony.json > secrets/linphone_password \
     && jq -je '.messageToken' nova-data/telephony.json > secrets/nova_message_token ) \
     && chown 10001:10001 secrets/linphone_password secrets/nova_message_token \
     && ls -ln secrets && test -s secrets/linphone_password && test -s secrets/nova_message_token && echo OK
   ```

   Bestanden zijn dan `0400`, eigenaar **uid 10001** (de gebruiker in de container; een root-eigen 0400-bestand is voor de container onleesbaar, getest). `jq -e` faalt als er geen trunk is. Het wachtwoord verschijnt nergens in uitvoer of git (`deploy/secrets/` staat in `.gitignore`; in productie ligt `secrets/` los van git).

2. **Datamap:** `install -d -m 0700 -o 10001 -g 10001 nova-data/linphone-chat`. Let op: een latere `chown -R 1000:1000 nova-data` (zoals in de kop van de compose) zet die map weer fout; herhaal dan deze regel. Wie de map leest, kan de chats lezen; zet hem niet onversleuteld in een back-up die je deelt.
3. **Bouwen op de host** (nooit pushen): `docker compose build linphone-chat` (download de wheel, controleert de sha256, ~2 min).
4. **Contact:** in NOVA Instellingen > Telefonie > Contacten moet jouw Linphone-adres "Mag met NOVA praten" aan hebben (zelfde lijst als voor de gewone tekst).
5. **Starten:** `docker compose --profile linphone-chat up -d linphone-chat` (of voeg `linphone-chat` toe aan `COMPOSE_PROFILES` in `.env`). Controle: `docker compose logs linphone-chat` (verwacht `registration state=Ok`, `started ... lime=True`) en `docker compose ps` (healthy).
6. **Testen:** start in je Linphone-app een **veilige** chat (slotje) met het NOVA-account. NOVA hoort te antwoorden, in dezelfde versleutelde kamer.
7. **Controleer de forking** (dit is wat niet geverifieerd is):
   - Stuur ook een **gewone** (niet-veilige) tekst: je moet precies **een** antwoord krijgen (van Asterisk) en `cleartextIgnored` in `docker compose exec linphone-chat /opt/venv/bin/python -I -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8099/health').read())"` gaat omhoog. Komt er geen antwoord: Flexisip bezorgt cleartext niet meer bij Asterisk; zet de brug dan uit (terugdraaien).
   - **Bel** het NOVA-nummer: Asterisk moet nog net zo opnemen als voorheen. `callsIgnored` stijgt, en in de Asterisk-log staat geen vreemde INVITE van de conferentieserver.

### Terugdraaien

`docker compose --profile linphone-chat stop linphone-chat && docker compose --profile linphone-chat rm -f linphone-chat`, en haal `linphone-chat` uit `COMPOSE_PROFILES`. Asterisk, relay en NOVA zijn niet gewijzigd (alleen `allowlist` geeft een extra veld `identity`). De brug meldt alleen zijn eigen contact af; het apparaat blijft hooguit tot het verlopen van de registratie (1 uur) bij Flexisip staan. Opruimen: `rm -rf nova-data/linphone-chat secrets/linphone_password secrets/nova_message_token` (de LIME-sleutels zijn daarna weg; bij een volgende start is het een nieuw apparaat).

## Tests die zijn uitgevoerd (2026-10-17)

- `docker build` van de image (ook met een bewust foute sha256: bouw mislukt) en `docker compose config` met en zonder profiel (en met `telephony` erbij) in een tijdelijke kopie.
- Unit-tests in de image (`python -I -m unittest discover -s /app -p 'test_bridge.py'`): 11 geslaagd.
- Rooktest in de image met `--network none` en een dode LIME-URL (`docker run --rm --network none --entrypoint /opt/venv/bin/python nova-linphone-chat:local -I /app/smoke_core.py`): alle controles geslaagd. Niets werd naar het echte Linphone gestuurd.
- Start van de echte `bridge.py` met een nep-NOVA (identiteit via `allowlist`) en een dode registrar: health 200, `registration` Failed, `device-id` aangemaakt.
- API: `npx vitest run test/telephony` (nieuw: identiteit zonder wachtwoord, `null` zonder trunk, geen berichttekst in audit), tsc, eslint, prettier.
- Gevonden en opgelost tijdens het testen: de Python-wrapper houdt de listener niet vast; zonder verwijzing komen er **geen** callbacks (de eerste versie van de brug had dit probleem).

## Niet geverifieerd (eerlijk)

- **Echt inloggen** op `sip.linphone.org` met `transport=tls` en het trunk-wachtwoord (digest, mogelijk TLS-certificaatcontrole in de container: CA-bundel `ca-certificates` zit in de image).
- **LIME-inschrijving** bij `lime.linphone.org` voor dit apparaat en of de gebruiker het nieuwe (onbevestigde) apparaat accepteert; `conference-factory@sip.linphone.org` als factory-URI (normaal via remote provisioning); automatisch accepteren van de inkomende kamer en ontsleutelen van een echt bericht.
- **Flexisip met twee registraties**: of cleartext echt naar beide gaat (het `200 OK` van de brug kan als "afgeleverd" tellen), of Asterisk een chatroom-INVITE van de conferentieserver krijgt en hoe die daarop reageert, max. aantal contacten, GRUU-toewijzing aan de brug.
- **Oproep-forking**: dat Flexisip de 488-tak van de brug negeert en op Asterisk wacht (verwacht, want alleen 6xx is globaal), en dat de bellende kant geen vertraging merkt. Alleen bewezen dat de SDK nooit 180/603 stuurt.
- Groepschats, bijlagen, ephemeral messages (bewust niet ondersteund), meerdere apparaten van de afzender.
- Licentie en ToS: de wheel is GPLv3 (metadata); de image blijft op de eigen host en gaat niet in releases of een register. Een automatisch bediend account valt onder Linphones gebruiksvoorwaarden: niet gecontroleerd. Niet-juridisch advies.

## Risico's

- **Gedeeld account**: de brug is een extra apparaat met toegang tot het account en de LIME-sleutels; wie `nova-data/linphone-chat` leest, leest de chats. Het wachtwoord staat in `secrets/linphone_password` (0400).
- **Afhankelijkheid van Belledonne**: wheels alleen voor cp312/x86_64, niet op PyPI; pin en bewaar de wheel. Elke liblinphone-update opnieuw rooktesten (`smoke_core.py`).
- **Vertrouwen**: de brug ziet de platte tekst en geeft die aan NOVA door; het eind-tot-eind-karakter eindigt in de brug (op je eigen server).
- **Omvang**: image 881 MB, eerste bouw ~2 min; limiet in de compose 768 MB RAM, 1 CPU.

## Stand van zaken (18-10-2026)

Werkt in productie op het bestaande NOVA-account (tweede apparaat naast Asterisk): een versleuteld (hangslot) 1-op-1-bericht van de toegestane contactpersoon wordt ontsleuteld, door NOVA beantwoord en het antwoord komt versleuteld terug in dezelfde chat. Gecontroleerd met een echt bericht vanaf de Linphone-app; platte berichten gaan nog steeds via Asterisk en de relay, gesprekken zijn ongewijzigd.

Bij de eerste uitrol gingen twee dingen mis die alleen live zichtbaar waren: de image had geen CA-certificaten (TLS naar Linphone faalde) en de verbinding met de LIME-sleutelserver faalde door IPv6 zonder route (IPv6 staat nu uit in de SDK). Zet `NOVA_CHAT_LOG_LEVEL=message` in `.env` om chatkamer- en LIME-gebeurtenissen te zien (zonder berichtinhoud); laat het niet aan staan.

Nog niet gecontroleerd: gedrag na een lange periode zonder verkeer (her-registratie, LIME-sleutels vernieuwen), meerdere toegestane contacten tegelijk, en een tweede apparaat van dezelfde persoon.
