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

## Getest

- Unit/integratie (26 tests, `apps/api/test/telephony`): configgeneratie en injectiebescherming, ARI-URL-validatie, Linphone-XML en eenmalige link, service met nep-ARI (originate, afspelen, ophangen, inkomend, deurbel-bridge), toolrisico en bevestiging via `ToolsService`.
- Echt: Asterisk 22.11.0-container + tweede Asterisk als SIP-client op een tijdelijk Docker-netwerk. Bevestigd: registratie en status "online", ARI-auth, echte Edge-TTS naar MP3-decode naar 16 kHz WAV, uitgaand gesprek waarbij de ontvanger ~4,5 s spraak opneemt, inkomend gesprek naar 700 geeft melding, deurbel 710 geeft kritieke melding en brug naar het overgaande toestel. Daarbij gevonden en opgelost: `acl=` verwijst naar `acl.conf` (nu per-endpoint `deny/permit`) en Asterisk speelt 16 kHz WAV alleen als `.wav16`.
- Niet getest: een echte Linphone-app (provisioning-XML volgt het lpconfig-formaat uit de Linphone-documentatie maar is niet op een toestel geprobeerd), SIP-trunk, Piper-stem, doorverbinden met meerdere telefoons.
