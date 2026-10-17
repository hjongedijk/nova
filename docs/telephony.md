# Telefonie: Asterisk en Linphone

Status: in productie beschikbaar (v0.1.56) maar standaard UIT. De Asterisk-container staat in de Compose met profiel `telephony`.

## Wat het is

- **Asterisk 22** (GPL-2.0, LTS) draait als eigen container (`deploy/asterisk`, compose-profiel `telephony`). NOVA bestuurt hem via de Asterisk REST Interface (ARI, HTTP + WebSocket). AMI staat uit.
- **Linphone** (GPLv3 of commerciele licentie; bevestigd op de GitHub-pagina van linphone-desktop) is de gratis SIP-app op je pc/telefoon. Het registreert als toestel bij Asterisk. NOVA gebruikt zelf geen liblinphone/`linphonec`: NOVA is een ARI-applicatie (`Stasis(nova)`), dat is headless en onderhouden. Een aparte linphonec-container zou een tweede, minder onderhouden SIP-stack toevoegen zonder voordeel.
- Wat werkt: status en geregistreerde toestellen, een toestel of extern nummer bellen en een tekst uitspreken (TTS), ophangen, gesprekken en events tonen, inkomend gesprek naar `700` geeft een NOVA-melding, deurbelnummer `710` geeft een kritieke melding en laat de ingestelde telefoons overgaan (eerste die opneemt wordt doorverbonden).
- **Niet** gebouwd: tweerichtings-spraak met NOVA over de telefoon (STT in de API bestaat niet; dat is nu browser-spraak). Een inkomend gesprek naar 700 krijgt een korte gesproken mededeling. Een volgende stap: ARI `snoop`/`record` naar een STT en antwoord via TTS.

## Beveiliging

- Geen standaardwachtwoorden: ARI-geheim en elk toestelwachtwoord worden willekeurig gegenereerd (`telephony.json`, 0600, in de datamap). De gegenereerde Asterisk-configuratie staat in `dev-data/asterisk/conf` (0600).
- Toestellen accepteren alleen verzoeken uit private netwerken (`deny=0.0.0.0/0` + `permit` voor RFC1918/CGNAT). Alle waarden worden gevalideerd voordat ze in de config komen (geen regelinjectie); wachtwoorden voor de trunk mogen geen `; = # [ ] " ' \` bevatten.
- Poorten in de dev-compose zijn standaard alleen op `127.0.0.1` gepubliceerd: SIP 5060 udp/tcp, ARI 8088 (altijd loopback) en RTP `10000-10100/udp` (aanpasbaar met `NOVA_RTP_START`/`NOVA_RTP_END`). Zet `NOVA_SIP_BIND` op een LAN-IP om telefoons in huis te laten registreren. Zet SIP nooit op een publiek adres; gebruik een VPN voor buiten de deur.
- De container draait met `cap_drop: ALL` plus CHOWN/DAC_OVERRIDE/FOWNER/SETUID/SETGID en `no-new-privileges`.
- Tools: `phone_status` (READ_ONLY), `phone_call` (CONFIRM, nooit "Altijd"; interne toestellen alleen SAFE als de gebruiker dat aanzet, externe nummers altijd bevestigen, max 5 uitgaande gesprekken per uur en 2 tegelijk), `phone_hangup` (SAFE). Alle tools zijn uitgeschakeld zolang Telefonie uit staat.
- De Linphone-koppellink is eenmalig en 10 minuten geldig; het XML-bestand bevat het SIP-wachtwoord en is alleen via de PIN-beveiligde instellingen te downloaden.

## Starten (dev)

1. NOVA starten, Instellingen > Telefonie: zet Telefonie aan. Dit genereert de configuratie.
2. `docker compose -f docker-compose.dev.yml --profile telephony up -d --build asterisk`
3. Voeg een toestel toe, stel het adres van Asterisk in (LAN-IP, vereist `NOVA_SIP_BIND` hetzelfde IP) en koppel Linphone via de eenmalige link of het XML-bestand.
4. Wijzigingen worden binnen ~5 s automatisch herladen door de container; geen herstart nodig (alleen een andere RTP-reeks of modules vereist een herstart).

Omgevingsvariabele: `NOVA_ASTERISK_ARI_URL` (standaard `http://127.0.0.1:8088`; alleen localhost, 127.0.0.1 of `asterisk`).

## Productie (Compose)

Asterisk staat in `deploy/docker-compose.yml` als service `asterisk` met profiel `telephony`, op het private `nova`-netwerk en zonder gepubliceerde poorten.
NOVA bereikt ARI en AudioSocket intern (`NOVA_ASTERISK_ARI_URL=http://asterisk:8088` staat vast in de compose). De image wordt lokaal gebouwd uit `./asterisk`
(zoals Piper): kopieer `deploy/asterisk` naast `docker-compose.yml`, zet `COMPOSE_PROFILES=...,telephony` in `.env`, zet Telefonie eenmalig aan in NOVA (dat maakt de configuratie
in `nova-data/asterisk/conf`) en start `docker compose up -d asterisk`. Releases leveren `asterisk/` mee in `nova-compose.tar.gz`.

De trunk naar `sip.linphone.org` is een uitgaande registratie: er hoeft niets van buitenaf naar binnen. Wil je ook telefoons op je eigen LAN laten registreren, publiceer dan zelf
SIP/RTP op een LAN-IP (nooit `0.0.0.0`) in een eigen override. NAT of andere netwerken vragen om `external_media_address`/`local_net` in een aangepaste transport-sectie.

Zolang er nog geen toestel of trunk is, meldt Asterisk geen PJSIP-endpoints; NOVA ziet dat als "nog geen toestellen" en niet als "onbereikbaar".

## Tekstberichten van Linphone en de SIP-relay

**Waarom.** Linphone verpakt elk bericht in een CPIM-envelop (`Content-Type: message/cpim`) en stuurt daarnaast typ-indicaties (`application/im-iscomposing+xml`) en ontvangstberichten (`message/imdn+xml`). Asterisks `res_pjsip_messaging` beantwoordt alles behalve `text/plain` met `415 Unsupported Media Type`, voordat het dialplan of NOVA het ziet; de image `andrius/asterisk` is niet te patchen. Uitgaande teksten van NOVA (ARI `sendMessage`, `text/plain`) werkten al.

**Hoe.** NOVA draait een kleine SIP-relay (`apps/api/src/telephony/sip-relay/`, alleen Node `net`) tussen Asterisk en de registrar:

- De gegenereerde `pjsip.conf` zet voor de trunk `outbound_proxy=sip:nova:5070\;transport=tcp\;lr` (op het endpoint en op de registratie; zonder `lr` stuurt PJSIP strikt-gerouteerd en wordt de proxy de Request-URI, dat is in de lab-test gebleken). De relay luistert op `0.0.0.0:5070` in de NOVA-container, maakt per verbinding van Asterisk een eigen TCP-verbinding naar de trunkhost (poort 5060, vast uit de configuratie, nooit uit het verkeer) en geeft alles byte voor byte door, ook de CRLF-keepalives. Beide kanten worden op `Content-Length` gesplitst (gefragmenteerd en samengevoegd verkeer, max 16 KiB koppen en 1 MiB body; onzin sluit alleen die ene verbinding).
- Alleen Flexisip naar Asterisk, alleen `MESSAGE`-verzoeken, worden aangepast: `message/cpim` met binnenin `text/plain` wordt `text/plain;charset=UTF-8` met alleen de tekst als body (andere charsets worden naar UTF-8 omgezet, `Content-Length` klopt weer); typ-indicaties en ontvangstberichten worden niet doorgegeven maar door de relay zelf met `200 OK` beantwoord; alles wat NOVA niet als tekst kan lezen (afbeeldingen/bestanden in CPIM, onbekende typen, tekst boven 8 KiB, versleuteld) krijgt ook `200 OK` en wordt weggegooid, met een teller. `text/plain`, alle andere methoden en alle antwoorden blijven onaangeroerd. Berichtinhoud wordt nooit gelogd, alleen methode, type en grootte.
- Enige verdere ingreep: de relay haalt de bovenste `Route` weg als die naar de relay zelf wijst, met de proxynaam of het adres van de relay (zoals elke proxy), anders zou de registrar alles naar `nova:5070` willen doorsturen.
- Omdat verzoeken nu van de relay komen, herkent Asterisk de trunk aan het `From`-domein (`identify_by=header` + `match_header=From: /@host/`) in plaats van aan het IP-adres.
- Geen open proxy: alleen verbindingen vanaf het adres van de `asterisk`-container worden aangenomen (naam wordt per verbinding opnieuw opgelost), maximaal 8 gelijktijdig, 2 uur inactiviteit sluit. Poort 5070 staat niet in `ports:` van de compose en is dus alleen op het interne `nova`-netwerk bereikbaar.
- SDP wordt niet aangeraakt: SDES-SRTP-media loopt end-to-end en gesprekken zijn onveranderd.

**Levensduur.** De relay start met NOVA zodra Telefonie aanstaat en er een trunk is, en herstart zichzelf (nieuw doel, nieuwe `pjsip.conf`) als de trunk wordt gewijzigd of verwijderd. Staat NOVA uit, dan mislukt de registratie van Asterisk en probeert hij opnieuw; de gegenereerde trunk heeft `retry_interval=15`, `forbidden_retry_interval=60`, `fatal_retry_interval=15` en `max_retries=1000000`. **Een NOVA-herstart of -deploy geeft dus ~15-60 s waarin er geen gesprekken of teksten binnenkomen**; daarna registreert Asterisk vanzelf opnieuw (in de lab-test 12 s nadat de relay terug was).

**Instellingen (omgeving).** `NOVA_SIP_RELAY=auto|on|off` (standaard `auto`: aan wanneer `NOVA_ASTERISK_ARI_URL` naar `asterisk` wijst, dus in de compose-stack; uit in een dev-opstelling met NOVA op de host), `NOVA_SIP_RELAY_PORT` (5070), `NOVA_SIP_RELAY_PROXY_HOST` (naam van de NOVA-container voor Asterisk, standaard `nova`), `NOVA_SIP_RELAY_BIND` (`0.0.0.0`), `NOVA_SIP_RELAY_UPSTREAM_PORT` (5060). De relay praat altijd platte TCP met de trunk; TLS naar de registrar is niet ingebouwd.

**Grenzen.** Geen bijlagen of afbeeldingen (Linphone stuurt die als HTTP-bestandsoverdracht in een CPIM-bericht: dat wordt weggegooid en geteld), geen groepschats en geen met LIME end-to-end versleutelde chats: die zijn niet te lezen en tellen als "onleesbaar". De teller `unreadable` met `lastUnreadableAt` is bedoeld zodat NOVA later kan melden dat er een bestand is gestuurd dat via de telefoon niet te lezen is.

**Troubleshooting.** De telefoniestatus (`/api/telephony/status`, veld `sipRelay`) toont `listening`, `activeConnections`, `rejected`, `rewritten`, `answered`, `dropped`, `unreadable`, `lastUnreadableAt` en `lastError`. Controle: `docker exec nova-asterisk-1 asterisk -rx "pjsip show registrations"` (moet `Registered` zijn) en `docker logs nova | grep "SIP relay"` (alleen metadata). `lastError: cannot listen: EADDRINUSE` betekent dat poort 5070 bezet is (`NOVA_SIP_RELAY_PORT`); `connection from a non-allowed address rejected` dat een ander dan de Asterisk-container probeerde te verbinden (of dat `asterisk` niet oplost); `upstream: ...` dat de registrar niet bereikbaar is; `malformed SIP` dat de andere kant geen SIP stuurde. Tekst komt niet aan terwijl `rewritten` niet oploopt: dan komt er niets via de relay (registratie? `outbound_proxy` in `pjsip.conf`?). Is `unreadable` hoog, dan stuurt de telefoon bijlagen of versleutelde chats.

**Lab-bewijs** (`apps/api/test/telephony/real-asterisk-relay.test.ts`, `NOVA_TEST_ASTERISK=1`): echte Asterisk 22 registreert via de relay bij een nep-Flexisip; een INVITE van de registrar bereikt Asterisk op de geregistreerde verbinding en wordt beantwoord; een CPIM-tekst komt als `text/plain` bij het NOVA-endpoint en het antwoord gaat via de relay terug als SIP MESSAGE; typ-indicaties en IMDN krijgen `200 OK` van de relay en bereiken Asterisk niet; na een relay-herstart registreert Asterisk zelf opnieuw. **Niet geverifieerd:** een echte Flexisip/sip.linphone.org en de echte Linphone-app (hoe Flexisip met de relay in het pad omgaat, bijvoorbeeld voor in-dialoog verzoeken en het `alias`-gedrag), versleutelde (LIME) en groepschats, bestandsoverdracht.

## Getest

- Unit/integratie (26 tests, `apps/api/test/telephony`): configgeneratie en injectiebescherming, ARI-URL-validatie, Linphone-XML en eenmalige link, service met nep-ARI (originate, afspelen, ophangen, inkomend, deurbel-bridge), toolrisico en bevestiging via `ToolsService`.
- Echt: Asterisk 22.11.0-container + tweede Asterisk als SIP-client op een tijdelijk Docker-netwerk. Bevestigd: registratie en status "online", ARI-auth, echte Edge-TTS naar MP3-decode naar 16 kHz WAV, uitgaand gesprek waarbij de ontvanger ~4,5 s spraak opneemt, inkomend gesprek naar 700 geeft melding, deurbel 710 geeft kritieke melding en brug naar het overgaande toestel. Daarbij gevonden en opgelost: `acl=` verwijst naar `acl.conf` (nu per-endpoint `deny/permit`) en Asterisk speelt 16 kHz WAV alleen als `.wav16`.
- Niet getest: een echte Linphone-app (provisioning-XML volgt het lpconfig-formaat uit de Linphone-documentatie maar is niet op een toestel geprobeerd), SIP-trunk, Piper-stem, doorverbinden met meerdere telefoons.
